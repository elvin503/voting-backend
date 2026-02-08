const express = require('express');
const Redis = require('ioredis');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Tesseract = require('tesseract.js');
require('dotenv').config();

// ================= SUPABASE =================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const app = express();
const PORT = process.env.PORT || 5000;

// ================= MIDDLEWARE =================
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ================= REDIS CONNECTION =================
const client = new Redis(process.env.REDIS_URL);
client.on('connect', () => console.log('✅ Connected to Redis!'));
client.on('error', (err) => console.error('Redis connection error:', err));

// ================= VOTING CODES (SEED ON START) =================
const VOTING_CODES = [
  'a1b2c3','f7g8h9','z0x9y8','m4n5o6','p1q2r3',
  's4t5u6','v7w8x9','y0z1a2','b3c4d5','e6f7g8',
  'h9i0j1','k2l3m4','n5o6p7','q8r9s0','t1u2v3',
  'w4x5y6','z7a8b9','c0d1e2','f3g4h5','i6j7k8',
  'l9m0n1','o2p3q4','r5s6t7','u8v9w0','x1y2z3',
  'a4b5c6','d7e8f9','g0h1i2','j3k4l5','m6n7o8'
];

(async () => {
  for (const code of VOTING_CODES) {
    await client.set(`vote:code:${code}`, 'unused', 'NX');
  }
  console.log('✅ Voting codes ready');
})();

// ================= UPLOAD CONFIG =================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });
app.use('/uploads', express.static(uploadDir));

// ================= STUDENT CRUD =================
app.post('/students', async (req, res) => {
  try {
    const { id, title, name, suffix, sex, birthday, age, postalCode, citizenship, civilStatus, course, address } = req.body;
    if (!id || !title || !name || !course || !age || !address || !sex || !birthday || !postalCode || !citizenship || !civilStatus) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    await client.hSet(`student:${id}`, { title, name, suffix, sex, birthday, age, postalCode, citizenship, civilStatus, course, address });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error saving student' });
  }
});

app.get('/students/:id', async (req, res) => {
  try {
    const student = await client.hGetAll(`student:${req.params.id}`);
    if (!student || Object.keys(student).length === 0) return res.status(404).json({ message: 'Student not found' });
    res.status(200).json(student);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error fetching student' });
  }
});

app.get('/students', async (_req, res) => {
  try {
    const keys = await client.keys('student:*');
    const students = await Promise.all(keys.map(async k => ({ id: k.split(':')[1], ...(await client.hGetAll(k)) })));
    res.status(200).json(students);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error fetching students' });
  }
});

// ================= CANDIDATES =================
// GET all candidates
app.get('/candidates', async (_req, res) => {
  try {
    const raw = await client.get('candidates');
    res.status(200).json(raw ? JSON.parse(raw) : []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error fetching candidates' });
  }
});

// ADD or UPDATE candidate with image to Supabase
app.post('/candidates', upload.single('photo'), async (req, res) => {
  try {
    const { index, position, name, courseYear, partylist, partylistColor } = req.body;

    if (!position || !name || !courseYear) return res.status(400).json({ message: 'Missing candidate info' });

    let photoUrl = '/default-avatar.png';

    // Upload photo to Supabase if exists
    if (req.file) {
      const filePath = `candidates/${Date.now()}-${req.file.originalname}`;

      const { error: uploadError } = await supabase.storage
        .from('candidate-images')
        .upload(filePath, fs.createReadStream(req.file.path), { contentType: req.file.mimetype });

      if (uploadError) throw uploadError;

      const { publicUrl, error: urlError } = supabase
        .storage
        .from('candidate-images')
        .getPublicUrl(filePath);

      if (urlError) throw urlError;

      photoUrl = publicUrl;
      fs.unlinkSync(req.file.path);
    }

    const newCandidate = { position, name, courseYear, partylist, partylistColor: partylistColor || '#000000', photo: photoUrl };

    const raw = await client.get('candidates');
    const list = raw ? JSON.parse(raw) : [];

    if (typeof index === 'number' && index >= 0 && index < list.length) {
      list[index] = newCandidate;
    } else {
      list.push(newCandidate);
    }

    await client.set('candidates', JSON.stringify(list));
    res.status(200).json({ success: true, candidate: newCandidate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error saving candidate' });
  }
});

// DELETE candidate
app.delete('/candidates/:index', async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const raw = await client.get('candidates');
    const list = raw ? JSON.parse(raw) : [];

    if (index >= 0 && index < list.length) {
      list.splice(index, 1);
      await client.set('candidates', JSON.stringify(list));
      return res.status(200).json({ success: true });
    }
    res.status(400).json({ message: 'Invalid candidate index' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error deleting candidate' });
  }
});

// ================= REST OF YOUR SERVER (OCR, voting, results) =================
// ... keep your existing endpoints: /verify-id, /check-code, /mark-code-used, /auth/login, /vote, /results ...

// ================= START SERVER =================
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
