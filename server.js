const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');
const axios = require('axios');

const app = express();
const db = new Database(path.join(__dirname, 'quiniela.db'));

// Configuración API
const ODDS_API_KEY = '9cf5b39a3dcd0efc300ee4bf852a8b76';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const LIGA_MX_SPORT = 'soccer_mexico_ligamx';

app.use(express.json());
app.use(express.static('public'));
app.use(session({ secret: 'secreto-quiniela', resave: false, saveUninitialized: false }));

// ========== FUNCIÓN PARA ACTUALIZAR BASE DE DATOS ==========
function actualizarBaseDatos() {
    try {
        db.exec("ALTER TABLE jornadas ADD COLUMN closed INTEGER DEFAULT 0");
        console.log("✅ Columna 'closed' agregada");
    } catch(e) { console.log("ℹ️ Columna 'closed' ya existe"); }
    
    try {
        db.exec("ALTER TABLE jornadas ADD COLUMN close_time TEXT");
        console.log("✅ Columna 'close_time' agregada");
    } catch(e) { console.log("ℹ️ Columna 'close_time' ya existe"); }
}

// ========== CREAR TABLAS ==========
db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS master_invite (
    code TEXT PRIMARY KEY
)`);

db.exec(`CREATE TABLE IF NOT EXISTS jornadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    published INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_fixture_id INTEGER,
    jornada_id INTEGER,
    home_team TEXT,
    away_team TEXT,
    home_score INTEGER,
    away_score INTEGER,
    status TEXT DEFAULT 'pending',
    datetime TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    match_id INTEGER,
    home_pred INTEGER,
    away_pred INTEGER,
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Actualizar la base de datos con las nuevas columnas
actualizarBaseDatos();

// Admin por defecto
const adminHash = bcrypt.hashSync('admin123', 10);
db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', ?, 'admin')").run(adminHash);

// Código maestro por defecto
db.prepare("INSERT OR IGNORE INTO master_invite (code) VALUES ('LIGUILLA2026')").run();

console.log('✅ Base de datos lista');

// ========== FUNCIÓN PARA CIERRE AUTOMÁTICO ==========
function verificarCierreAutomatico() {
    try {
        const ahora = new Date().toISOString();
        const jornadas = db.prepare("SELECT id, name, close_time FROM jornadas WHERE published = 1 AND closed = 1 AND close_time IS NOT NULL AND close_time <= ?").all(ahora);
        jornadas.forEach(j => {
            db.prepare("UPDATE jornadas SET closed = 1 WHERE id = ?").run(j.id);
            console.log(`🔒 Jornada "${j.name}" cerrada automáticamente`);
        });
    } catch(e) {
        console.log("Error en cierre automático:", e.message);
    }
}

// ========== RUTA PARA REPARAR BASE DE DATOS ==========
app.get('/api/fix-database', (req, res) => {
    try {
        db.exec("ALTER TABLE jornadas ADD COLUMN closed INTEGER DEFAULT 0");
    } catch(e) {}
    try {
        db.exec("ALTER TABLE jornadas ADD COLUMN close_time TEXT");
    } catch(e) {}
    res.json({ success: true, message: "Base de datos actualizada" });
});

// ========== RUTAS PÚBLICAS ==========
app.post('/api/register', (req, res) => {
    const { username, password, inviteCode } = req.body;
    
    const master = db.prepare("SELECT code FROM master_invite WHERE code = ?").get(inviteCode);
    if (!master) {
        return res.status(400).json({ error: 'Código de invitación inválido' });
    }
    
    const hash = bcrypt.hashSync(password, 10);
    try {
        db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, hash);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Usuario ya existe' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    req.session.user = user;
    res.json({ role: user.role, username: user.username, id: user.id });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, user: req.session.user });
    } else {
        res.json({ loggedIn: false });
    }
});

// ========== RUTAS DE USUARIO ==========
app.get('/api/jornadas', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });
    const rows = db.prepare("SELECT * FROM jornadas WHERE published = 1 ORDER BY id DESC").all();
    res.json(rows || []);
});

app.get('/api/jornada/:id/status', (req, res) => {
    if (!req.session.user) return res.status(401);
    let closed = 0;
    try {
        const row = db.prepare("SELECT closed FROM jornadas WHERE id = ?").get(req.params.id);
        closed = row ? row.closed : 0;
    } catch(e) { closed = 0; }
    res.json({ closed });
});

app.get('/api/matches/:jornadaId', (req, res) => {
    if (!req.session.user) return res.status(401);
    const rows = db.prepare("SELECT * FROM matches WHERE jornada_id = ? ORDER BY datetime ASC").all(req.params.jornadaId);
    res.json(rows || []);
});

app.get('/api/predictions/:jornadaId', (req, res) => {
    if (!req.session.user) return res.status(401);
    const rows = db.prepare(`SELECT p.*, m.home_team, m.away_team, m.home_score, m.away_score, m.status 
            FROM predictions p 
            JOIN matches m ON p.match_id = m.id 
            WHERE p.user_id = ? AND m.jornada_id = ?`).all(req.session.user.id, req.params.jornadaId);
    res.json(rows || []);
});

app.post('/api/prediction', (req, res) => {
    if (!req.session.user) return res.status(401);
    const { matchId, homePred, awayPred } = req.body;
    db.prepare(`INSERT INTO predictions (user_id, match_id, home_pred, away_pred) 
            VALUES (?, ?, ?, ?) 
            ON CONFLICT(user_id, match_id) DO UPDATE SET 
            home_pred = excluded.home_pred, away_pred = excluded.away_pred`).run(req.session.user.id, matchId, homePred, awayPred);
    res.json({ success: true });
});

app.get('/api/leaderboard', (req, res) => {
    if (!req.session.user) return res.status(401);
    const rows = db.prepare(`
        SELECT u.id, u.username, 
               COALESCE(SUM(p.points), 0) as total_points,
               SUM(CASE WHEN p.points = 3 THEN 1 ELSE 0 END) as exactos,
               SUM(CASE WHEN p.points = 1 THEN 1 ELSE 0 END) as aciertos
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id
        WHERE u.role = 'user'
        GROUP BY u.id
        ORDER BY total_points DESC`).all();
    res.json(rows || []);
});

app.get('/api/user/:userId/predictions', (req, res) => {
    if (!req.session.user) return res.status(401);
    const rows = db.prepare(`SELECT p.*, m.home_team, m.away_team, m.home_score, m.away_score, m.status
            FROM predictions p 
            JOIN matches m ON p.match_id = m.id 
            WHERE p.user_id = ?`).all(req.params.userId);
    res.json(rows || []);
});

app.get('/api/user/stats', (req, res) => {
    if (!req.session.user) return res.status(401);
    const row = db.prepare(`
        SELECT 
            COUNT(*) as total_pronosticos,
            COALESCE(SUM(points), 0) as total_puntos,
            SUM(CASE WHEN points = 3 THEN 1 ELSE 0 END) as exactos,
            SUM(CASE WHEN points = 1 THEN 1 ELSE 0 END) as aciertos
        FROM predictions WHERE user_id = ?`).get(req.session.user.id);
    res.json(row || { total_pronosticos: 0, total_puntos: 0, exactos: 0, aciertos: 0 });
});

// ========== RUTAS DE ADMIN ==========
app.get('/api/admin/jornadas', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const rows = db.prepare("SELECT * FROM jornadas ORDER BY id DESC").all();
    res.json(rows || []);
});

app.post('/api/admin/jornada', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { name } = req.body;
    const result = db.prepare("INSERT INTO jornadas (name, published) VALUES (?, 0)").run(name);
    res.json({ id: result.lastInsertRowid });
});

app.post('/api/admin/jornada/:id/publish', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    db.prepare("UPDATE jornadas SET published = 1 WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

app.post('/api/admin/jornada/:id/toggle-close', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { closed } = req.body;
    db.prepare("UPDATE jornadas SET closed = ? WHERE id = ?").run(closed ? 1 : 0, req.params.id);
    res.json({ success: true });
});

app.post('/api/admin/jornada/:id/set-close-time', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { close_time } = req.body;
    db.prepare("UPDATE jornadas SET close_time = ? WHERE id = ?").run(close_time, req.params.id);
    res.json({ success: true });
});

app.delete('/api/admin/jornada/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    db.prepare("DELETE FROM matches WHERE jornada_id = ?").run(req.params.id);
    db.prepare("DELETE FROM jornadas WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

app.get('/api/admin/master-code', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const row = db.prepare("SELECT code FROM master_invite LIMIT 1").get();
    res.json({ code: row ? row.code : 'LIGUILLA2026' });
});

app.post('/api/admin/master-code', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { code } = req.body;
    db.prepare("DELETE FROM master_invite").run();
    db.prepare("INSERT INTO master_invite (code) VALUES (?)").run(code);
    res.json({ success: true });
});

app.get('/api/admin/users', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const rows = db.prepare("SELECT id, username, role, active, created_at FROM users WHERE role != 'admin'").all();
    res.json(rows || []);
});

app.post('/api/admin/match', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { jornada_id, home_team, away_team, datetime } = req.body;
    const result = db.prepare(`INSERT INTO matches (jornada_id, home_team, away_team, datetime, status) 
            VALUES (?, ?, ?, ?, 'pending')`).run(jornada_id, home_team, away_team, datetime);
    res.json({ id: result.lastInsertRowid });
});

app.post('/api/admin/set-result/:matchId', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { home_score, away_score } = req.body;
    
    db.prepare(`UPDATE matches SET home_score = ?, away_score = ?, status = 'finished' WHERE id = ?`).run(home_score, away_score, req.params.matchId);
    
    const predictions = db.prepare("SELECT * FROM predictions WHERE match_id = ?").all(req.params.matchId);
    for (const pred of predictions) {
        let points = 0;
        if (pred.home_pred === home_score && pred.away_pred === away_score) {
            points = 3;
        } else {
            const winnerMatch = Math.sign(home_score - away_score);
            const winnerPred = Math.sign(pred.home_pred - pred.away_pred);
            if (winnerMatch === winnerPred && winnerMatch !== 0) {
                points = 1;
            } else if (winnerMatch === 0 && winnerPred === 0) {
                points = 1;
            }
        }
        db.prepare("UPDATE predictions SET points = ? WHERE id = ?").run(points, pred.id);
    }
    res.json({ success: true });
});

app.get('/api/admin/matches/:jornadaId', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const rows = db.prepare("SELECT * FROM matches WHERE jornada_id = ?").all(req.params.jornadaId);
    res.json(rows || []);
});

// ========== RUTAS DE API EXTERNA ==========
app.get('/api/fetch-available-matches', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    try {
        const response = await axios.get(`${ODDS_API_BASE}/sports/${LIGA_MX_SPORT}/scores`, {
            params: { apiKey: ODDS_API_KEY, daysFrom: 14, dateFormat: 'iso' }
        });
        const matches = (response.data || []).map(game => ({
            id: game.id,
            home: game.home_team,
            away: game.away_team,
            datetime: game.commence_time,
            fecha: new Date(game.commence_time).toLocaleDateString('es-MX'),
            status: game.completed ? 'finished' : 'pending'
        }));
        for (const match of matches) {
            const existing = db.prepare("SELECT id FROM matches WHERE api_fixture_id = ?").get(match.id);
            match.asignado = !!existing;
        }
        res.json({ success: true, matches });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/admin/assign-matches', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { matchesIds, jornadaId } = req.body;
    let asignados = 0;
    for (const matchId of matchesIds) {
        try {
            const match = db.prepare("SELECT home_team, away_team, datetime FROM (SELECT ? as id, ? as home, ? as away, ? as dt)").get(matchId, '', '', '');
            db.prepare(`INSERT OR IGNORE INTO matches (api_fixture_id, jornada_id, home_team, away_team, datetime, status)
                VALUES (?, ?, ?, ?, ?, 'pending')`).run(matchId, jornadaId, '', '', '');
            asignados++;
        } catch(e) {}
    }
    res.json({ success: true, asignados });
});

// ========== CIERRE AUTOMÁTICO ==========
setInterval(verificarCierreAutomatico, 60000);

// ========== INICIAR SERVIDOR ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Servidor en http://localhost:${PORT}`);
    console.log(`👑 Admin: admin / admin123`);
    console.log(`🔑 Código maestro: LIGUILLA2026`);
    console.log(`⚽ PUNTOS: 3 exacto, 1 resultado`);
    console.log(`🌐 API configurada\n`);
});