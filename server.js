const express = require('express');
const Redis = require('ioredis');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();


const app = express();
const PORT = process.env.PORT || 5000;

// ================= MIDDLEWARE =================
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ================= REDIS =================
const client = new Redis(process.env.REDIS_URL);

client.on('connect', () => console.log('✅ Connected to Redis!'));
client.on('error', (err) => console.error('Redis error:', err));

// ================= SUPABASE =================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// temp folder
if (!fs.existsSync('temp')) {
  fs.mkdirSync('temp');
}

const upload = multer({ dest: 'temp/' });


// ================= SAFE SCAN FUNCTION =================
async function scanKeys(pattern) {
  let cursor = '0';
  const keys = [];

  do {
    const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== '0');

  return keys;
}


// ================= VOTING CODES =================
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


// ================= SUPABASE PHOTO UPLOAD =================
app.post('/upload-photo', upload.single('photo'), async (req, res) => {
  try {

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const file = req.file;
    const fileBuffer = fs.readFileSync(file.path);

    const fileName = `candidate-${Date.now()}${path.extname(file.originalname)}`;

    const { error } = await supabase.storage
      .from('candidate-photos') // bucket name
      .upload(fileName, fileBuffer, {
        contentType: file.mimetype,
      });

    if (error) throw error;

    const { data } = supabase
      .storage
      .from('candidate-photos')
      .getPublicUrl(fileName);

    fs.unlinkSync(file.path); // delete temp file

    res.status(200).json({
      url: data.publicUrl
    });

  } catch (err) {

    console.error("SUPABASE UPLOAD ERROR:", err);

    res.status(500).json({
      message: 'Upload failed'
    });

  }
});


// ================= STUDENTS =================
app.post('/students', async (req, res) => {
  try {
    const { id, title, name, suffix, sex, birthday, age, postalCode, citizenship, civilStatus, course, address } = req.body;

    await client.hSet(`student:${id}`, {
      title, name, suffix, sex, birthday, age,
      postalCode, citizenship, civilStatus, course, address
    });

    res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error saving student' });
  }
});


app.get('/students', async (_req, res) => {
  try {

    const keys = await scanKeys('student:*');

    const students = await Promise.all(
      keys.map(async k => ({
        id: k.split(':')[1],
        ...(await client.hgetAll(k))
      }))
    );

    res.status(200).json(students);

  } catch (err) {
    res.status(500).json({ message: 'Server error fetching students' });
  }
});


app.get('/students/:id', async (req, res) => {
  const student = await client.hgetAll(`student:${req.params.id}`);

  if (!student || Object.keys(student).length === 0) {
    return res.status(404).json({ message: 'Student not found' });
  }

  res.status(200).json(student);
});


app.put('/students/:id', async (req, res) => {
  await client.hSet(`student:${req.params.id}`, req.body);
  res.status(200).json({ success: true });
});

// ================= DELETE SINGLE VOTER =================
app.delete('/vote-record/:studentID', async (req, res) => {
  try {
    const { studentID } = req.params;

    const rawRecords = await client.lrange('voteRecords', 0, -1);
    const records = rawRecords.map(r => JSON.parse(r));

    const recordIndex = records.findIndex(r => r.studentID === studentID);
    if (recordIndex === -1) {
      return res.status(404).json({ message: 'Voter record not found' });
    }

    const [removedRecord] = records.splice(recordIndex, 1);

    // Restore code for reuse
    if (removedRecord.code) {
      await client.set(`vote:code:${removedRecord.code}`, 'unused');
    }

    // Update vote counts
    for (const [position, candidate] of Object.entries(removedRecord.votes)) {
      const key = `votes:${position}`;
      const current = await client.hget(key, candidate);
      if (current && Number(current) > 0) {
        const newCount = Number(current) - 1;
        if (newCount === 0) {
          await client.hdel(key, candidate);
        } else {
          await client.hset(key, candidate, newCount);
        }
      }
    }

    // Rebuild voteRecords list
    await client.del('voteRecords');
    if (records.length > 0) {
      await client.lpush('voteRecords', ...records.map(r => JSON.stringify(r)));
    }

    // Remove "already voted" flag
    await client.del(`vote:used:${studentID}`);

    // Optionally remove auth info
    await client.del(`auth:voter:${studentID}`);

    res.status(200).json({ success: true, message: 'Voter and votes deleted successfully!' });

  } catch (err) {
    console.error("Delete voter error:", err);
    res.status(500).json({ success: false, message: 'Failed to delete voter' });
  }
});



app.delete('/students/:id', async (req, res) => {
  await client.del(`student:${req.params.id}`);
  res.status(200).json({ success: true });
});


// ================= CANDIDATES =================
app.get('/candidates', async (_req, res) => {
  const raw = await client.get('candidates');
  res.status(200).json(raw ? JSON.parse(raw) : []);
});


app.post('/candidates', async (req, res) => {

  const { index, ...candidateData } = req.body;

  const raw = await client.get('candidates');
  const list = raw ? JSON.parse(raw) : [];

  if (typeof index === 'number' && index >= 0 && index < list.length) {
    list[index] = candidateData;
  } else {
    list.push(candidateData);
  }

  await client.set('candidates', JSON.stringify(list));

  res.status(200).json({ success: true });
});


app.delete('/candidates/:index', async (req, res) => {

  const index = parseInt(req.params.index);

  const raw = await client.get('candidates');
  const list = raw ? JSON.parse(raw) : [];

  list.splice(index, 1);

  await client.set('candidates', JSON.stringify(list));

  res.status(200).json({ success: true });
});


// ================= OCR / ID VERIFICATION =================
const uploadID = multer({ dest: 'temp/' }); // multer for temporary ID uploads

/**
 * POST /verify-id
 * Accepts either:
 * - image file upload (multipart/form-data)
 * - or base64 image in JSON { image: "data:image/png;base64,..." }
 * Returns: { verified: true/false, text: "RAW OCR TEXT" }
 */
app.post('/verify-id', uploadID.single('photo'), async (req, res) => {
  try {
    let buffer;

    // 1️⃣ If file uploaded
    if (req.file) {
      buffer = fs.readFileSync(req.file.path);
    }
    // 2️⃣ If base64 in body
    else if (req.body.image) {
      buffer = Buffer.from(
        req.body.image.replace(/^data:image\/\w+;base64,/, ''),
        'base64'
      );
    } else {
      return res.status(400).json({ verified: false, message: "No image provided" });
    }

    // OCR using Tesseract.js
    const result = await Tesseract.recognize(buffer, 'eng', {
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:-.',
      tessedit_pageseg_mode: 6
    });

    const rawText = result.data.text.toUpperCase();
    const text = rawText.replace(/[\s\n\r]+/g, ' ')
                        .replace(/[.,]/g, '')
                        .trim();

    // ✅ Validation rules
    const verified =
      text.includes("MEDINA") &&
      text.includes("COLLEGE") 
      

    // Clean up temp file if uploaded
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(200).json({ verified, text: rawText });

  } catch (err) {
    console.error("OCR Verification Error:", err);
    res.status(500).json({ verified: false, text: "", message: "OCR failed" });
  }
});


// ================= VOTING =================
app.post('/check-code', async (req, res) => {

  const { code } = req.body;

  const status = await client.get(`vote:code:${code}`);

  if (!status) return res.status(400).json({ message: 'Code does not exist' });
  if (status === 'used') return res.status(400).json({ message: 'Code already used' });

  res.status(200).json({ message: 'Code is valid' });
});


app.post('/mark-code-used', async (req, res) => {

  const { code, studentID, name } = req.body;

  await client.multi()
    .set(`vote:code:${code}`, 'used')
    .hSet(`auth:voter:${studentID}`, { name, code })
    .exec();

  res.status(200).json({ message: 'Code marked as used' });
});


app.post('/auth/login', async (req, res) => {

  const voter = await client.hgetAll(`auth:voter:${req.body.studentID}`);

  if (!voter || Object.keys(voter).length === 0) {
    return res.status(404).json({ message: 'Voter not found' });
  }

  const voted = await client.exists(`vote:used:${req.body.studentID}`);

  res.status(200).json({
    voter,
    alreadyVoted: Boolean(voted)
  });
});


app.post('/vote', async (req, res) => {
  try {
    const { studentID, votes, name, code } = req.body;

    if (!studentID || !votes || Object.keys(votes).length === 0 || !code) {
      return res.status(400).json({ message: 'Invalid vote data' });
    }

    // Check if code is already used
    const codeStatus = await client.get(`vote:code:${code}`);
    if (!codeStatus) return res.status(400).json({ message: 'Code does not exist' });
    if (codeStatus === 'used') return res.status(403).json({ message: 'Code already used' });

    // count votes
    for (const pos in votes) {
      const candidate = votes[pos] || "No selection";
      await client.hincrby(`votes:${pos}`, candidate, 1);
    }

    // Save vote record WITH voter name AND code
    await client.lpush(
      'voteRecords',
      JSON.stringify({
        studentID,
        name,
        code,            // store code
        votes,
        time: new Date().toISOString()
      })
    );

    // mark voter as voted
    await client.set(`vote:used:${studentID}`, '1');

    // mark the code as used
    await client.set(`vote:code:${code}`, 'used');

    // store voter auth info
    await client.hset(`auth:voter:${studentID}`, { name, code });

    res.status(200).json({ success: true });

  } catch (err) {
    console.error("Vote endpoint error:", err);
    res.status(500).json({ message: 'Voting failed' });
  }
});






// ================= RESET VOTES =================
app.post('/reset-votes', async (_req, res) => {
  try {
    // 1️⃣ Delete all vote counts
    const voteKeys = await scanKeys('votes:*');
    for (const key of voteKeys) {
      await client.del(key);
    }

    // 2️⃣ Delete all vote records
    await client.del('voteRecords');

    // 3️⃣ Delete all "already voted" flags
    const usedKeys = await scanKeys('vote:used:*');
    for (const key of usedKeys) {
      await client.del(key);
    }

    // 4️⃣ Reset all voting codes to 'unused'
    const codeKeys = await scanKeys('vote:code:*');
    for (const key of codeKeys) {
      await client.set(key, 'unused');
    }

    res.status(200).json({ success: true, message: 'All votes and codes reset successfully!' });
  } catch (err) {
    console.error("Reset votes error:", err);
    res.status(500).json({ success: false, message: 'Failed to reset votes and codes' });
  }
});




// ================= RESULTS (SAFE SCAN) =================
app.get('/results', async (req, res) => {
  try {
    // Scan all vote hashes
    const keys = await scanKeys('votes:*');
    const votesCount = {};

    for (const key of keys) {
      const position = key.split(':')[1];
      const results = await client.hgetall(key);
      for (const candidate in results) {
        votesCount[`${position}_${candidate}`] = Number(results[candidate]);
      }
    }

    // Get vote records
    const raw = await client.lrange('voteRecords', 0, -1);
    const voteRecords = raw.map(r => {
      const record = JSON.parse(r);
      return {
        ...record,
        name: record.name || "Unknown Voter" // ✅ fixed
      };
    });

    res.json({
      votesCount,
      voteRecords
    });

  } catch (err) {
    console.error("Results error:", err);
    res.status(500).json({ error: "Failed to fetch results" });
  }
});



(async () => {

  try {
    await client.set('startup-test', 'OK');
    console.log('✅ Upstash Ready');
  } catch {
    console.log('❌ Upstash FAILED');
  }

  try {
    await supabase.storage
      .from('candidate-photos')
      .list('', { limit: 1 });

    console.log('✅ Supabase Ready');
  } catch {
    console.log('❌ Supabase FAILED');
  }

})();
app.get('/', (req, res) => {
  res.send("🔥 Voting Server is LIVE");
});


// ================= START =================
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
