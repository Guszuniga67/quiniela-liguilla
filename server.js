const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const axios = require('axios');

const app = express();
const db = new sqlite3.Database(path.join(__dirname, 'quiniela.db'));

// Configuración API
const ODDS_API_KEY = '9cf5b39a3dcd0efc300ee4bf852a8b76';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const LIGA_MX_SPORT = 'soccer_mexico_ligamx';

app.use(express.json());
app.use(express.static('public'));
app.use(session({ secret: 'secreto-quiniela', resave: false, saveUninitialized: false }));

// ========== FUNCIÓN PARA CIERRE AUTOMÁTICO ==========
function verificarCierreAutomatico() {
    const ahora = new Date().toISOString();
    db.all("SELECT id, name, close_time FROM jornadas WHERE published = 1 AND closed = 0 AND close_time IS NOT NULL AND close_time <= ?", [ahora], (err, jornadas) => {
        if (jornadas && jornadas.length > 0) {
            jornadas.forEach(j => {
                db.run("UPDATE jornadas SET closed = 1 WHERE id = ?", [j.id]);
                console.log(`🔒 Jornada "${j.name}" cerrada automáticamente a las ${new Date().toLocaleString()}`);
            });
        }
    });
}

// ========== CREAR TABLAS ==========
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'user',
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS master_invite (
        code TEXT PRIMARY KEY
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS jornadas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        published INTEGER DEFAULT 0,
        closed INTEGER DEFAULT 0,
        close_time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS matches (
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

    db.run(`CREATE TABLE IF NOT EXISTS predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        match_id INTEGER,
        home_pred INTEGER,
        away_pred INTEGER,
        points INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Admin por defecto
    const adminHash = bcrypt.hashSync('admin123', 10);
    db.run("INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', ?, 'admin')", [adminHash]);
    
    // Código maestro por defecto
    db.run("INSERT OR IGNORE INTO master_invite (code) VALUES ('LIGUILLA2026')");
    
    console.log('✅ Base de datos lista');
});

// ========== RUTAS PÚBLICAS ==========
app.post('/api/register', (req, res) => {
    const { username, password, inviteCode } = req.body;
    
    db.get("SELECT code FROM master_invite WHERE code = ?", [inviteCode], (err, master) => {
        if (!master) {
            return res.status(400).json({ error: 'Código de invitación inválido' });
        }
        
        const hash = bcrypt.hashSync(password, 10);
        db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], function(err) {
            if (err) {
                return res.status(400).json({ error: 'Usuario ya existe' });
            }
            res.json({ success: true });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND active = 1", [username], (err, user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }
        req.session.user = user;
        res.json({ role: user.role, username: user.username, id: user.id });
    });
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
    db.all("SELECT * FROM jornadas WHERE published = 1 ORDER BY id DESC", (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/jornada/:id/status', (req, res) => {
    if (!req.session.user) return res.status(401);
    db.get("SELECT closed FROM jornadas WHERE id = ?", [req.params.id], (err, row) => {
        res.json({ closed: row ? row.closed : 0 });
    });
});

app.get('/api/matches/:jornadaId', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });
    db.all("SELECT * FROM matches WHERE jornada_id = ? ORDER BY datetime ASC", [req.params.jornadaId], (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/predictions/:jornadaId', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });
    db.all(`SELECT p.*, m.home_team, m.away_team, m.home_score, m.away_score, m.status 
            FROM predictions p 
            JOIN matches m ON p.match_id = m.id 
            WHERE p.user_id = ? AND m.jornada_id = ?`,
            [req.session.user.id, req.params.jornadaId], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/prediction', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });
    const { matchId, homePred, awayPred } = req.body;
    db.run(`INSERT INTO predictions (user_id, match_id, home_pred, away_pred) 
            VALUES (?, ?, ?, ?) 
            ON CONFLICT(user_id, match_id) DO UPDATE SET 
            home_pred = excluded.home_pred, away_pred = excluded.away_pred`,
            [req.session.user.id, matchId, homePred, awayPred], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/leaderboard', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });
    db.all(`
        SELECT u.id, u.username, 
               COALESCE(SUM(p.points), 0) as total_points,
               SUM(CASE WHEN p.points = 3 THEN 1 ELSE 0 END) as exactos,
               SUM(CASE WHEN p.points = 1 THEN 1 ELSE 0 END) as aciertos
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id
        WHERE u.role = 'user'
        GROUP BY u.id
        ORDER BY total_points DESC
    `, (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/user/:userId/predictions', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });
    db.all(`SELECT p.*, m.home_team, m.away_team, m.home_score, m.away_score, m.status
            FROM predictions p 
            JOIN matches m ON p.match_id = m.id 
            WHERE p.user_id = ?`,
            [req.params.userId], (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/user/stats', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });
    db.get(`
        SELECT 
            COUNT(*) as total_pronosticos,
            COALESCE(SUM(points), 0) as total_puntos,
            SUM(CASE WHEN points = 3 THEN 1 ELSE 0 END) as exactos,
            SUM(CASE WHEN points = 1 THEN 1 ELSE 0 END) as aciertos
        FROM predictions WHERE user_id = ?`,
        [req.session.user.id], (err, row) => {
        res.json(row || { total_pronosticos: 0, total_puntos: 0, exactos: 0, aciertos: 0 });
    });
});

// ========== RUTAS DE ADMIN ==========
app.get('/api/admin/jornadas', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    db.all("SELECT * FROM jornadas ORDER BY id DESC", (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/jornada', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { name } = req.body;
    db.run("INSERT INTO jornadas (name, published) VALUES (?, 0)", [name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.post('/api/admin/jornada/:id/publish', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    db.run("UPDATE jornadas SET published = 1 WHERE id = ?", [req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/jornada/:id/toggle-close', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { closed } = req.body;
    db.run("UPDATE jornadas SET closed = ? WHERE id = ?", [closed ? 1 : 0, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, closed });
    });
});

app.post('/api/admin/jornada/:id/set-close-time', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { close_time } = req.body;
    db.run("UPDATE jornadas SET close_time = ? WHERE id = ?", [close_time, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/admin/jornada/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const jornadaId = req.params.id;
    
    db.run("DELETE FROM matches WHERE jornada_id = ?", [jornadaId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run("DELETE FROM jornadas WHERE id = ?", [jornadaId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

app.get('/api/admin/master-code', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    db.get("SELECT code FROM master_invite LIMIT 1", (err, row) => {
        res.json({ code: row ? row.code : 'LIGUILLA2026' });
    });
});

app.post('/api/admin/master-code', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Código requerido' });
    
    db.run("DELETE FROM master_invite", (err) => {
        db.run("INSERT INTO master_invite (code) VALUES (?)", [code], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, code });
        });
    });
});

app.get('/api/admin/users', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    db.all("SELECT id, username, role, active, created_at FROM users WHERE role != 'admin'", (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/match', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { jornada_id, home_team, away_team, datetime } = req.body;
    db.run(`INSERT INTO matches (jornada_id, home_team, away_team, datetime, status) 
            VALUES (?, ?, ?, ?, 'pending')`,
            [jornada_id, home_team, away_team, datetime], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.post('/api/admin/set-result/:matchId', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    const { home_score, away_score } = req.body;
    
    db.run(`UPDATE matches SET home_score = ?, away_score = ?, status = 'finished' WHERE id = ?`,
            [home_score, away_score, req.params.matchId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all("SELECT * FROM predictions WHERE match_id = ?", [req.params.matchId], (err, predictions) => {
            if (predictions) {
                predictions.forEach(pred => {
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
                    db.run("UPDATE predictions SET points = ? WHERE id = ?", [points, pred.id]);
                });
            }
            res.json({ success: true });
        });
    });
});

app.get('/api/admin/matches/:jornadaId', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    db.all("SELECT * FROM matches WHERE jornada_id = ?", [req.params.jornadaId], (err, rows) => {
        res.json(rows || []);
    });
});

// ========== RUTAS DE API EXTERNA ==========
app.get('/api/fetch-available-matches', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403);
    
    try {
        const response = await axios.get(`${ODDS_API_BASE}/sports/${LIGA_MX_SPORT}/scores`, {
            params: {
                apiKey: ODDS_API_KEY,
                daysFrom: 14,
                dateFormat: 'iso'
            }
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
            const existing = await new Promise(resolve => {
                db.get("SELECT id FROM matches WHERE api_fixture_id = ?", [match.id], (err, row) => {
                    resolve(row);
                });
            });
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
    
    if (!matchesIds || matchesIds.length === 0) {
        return res.status(400).json({ error: 'No hay partidos para asignar' });
    }
    
    let asignados = 0;
    let procesos = 0;
    
    matchesIds.forEach(matchId => {
        db.run(`INSERT OR IGNORE INTO matches (api_fixture_id, jornada_id, home_team, away_team, datetime, status)
                SELECT ?, ?, home_team, away_team, datetime, 'pending'
                FROM (
                    SELECT ? as id, ? as home, ? as away, ? as dt
                ) WHERE NOT EXISTS (SELECT 1 FROM matches WHERE api_fixture_id = ?)`,
                [matchId, jornadaId, matchId, '', '', '', matchId], function(err) {
            procesos++;
            if (!err && this.changes > 0) asignados++;
            if (procesos === matchesIds.length) {
                res.json({ success: true, asignados });
            }
        });
    });
});

// ========== CIERRE AUTOMÁTICO ==========
setInterval(verificarCierreAutomatico, 60000);

// ========== INICIAR SERVIDOR ==========
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Servidor en http://localhost:${PORT}`);
    console.log(`👑 Admin: admin / admin123`);
    console.log(`🔑 Código maestro: LIGUILLA2026 (cambiable en admin)`);
    console.log(`⚽ PUNTOS: 3 exacto, 1 resultado`);
    console.log(`🌐 The Odds API configurada`);
    console.log(`⏰ Cierre automático de pronósticos activado\n`);
});