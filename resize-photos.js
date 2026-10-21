// resize-photos.js
// One-time script: shrinks existing photos in Supabase Storage, in place (same paths, so DB links keep working).
//
// Setup:
//   npm install @supabase/supabase-js sharp heic-convert
//
// HEIC/HEIF files are converted to JPEG but keep their original path (e.g. photo.heic),
// so DB links don't break. They're saved with content type image/jpeg, which is what
// browsers go by — and unlike HEIC, every browser can display them.
//
// Run (dry run first, it changes nothing and shows what would happen):
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxxx node resize-photos.js
//
// Test on a handful for real, then check them in the portal:
//   ... node resize-photos.js --apply --limit=5
//
// Run for real on everything:
//   ... node resize-photos.js --apply
//
// NOTE: --apply overwrites the originals. The service role key bypasses RLS,
// so only use it on your own machine and never put it in the portal code.

const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const heicConvert = require('heic-convert'); // sharp can't decode HEIC on its own

// ---- Settings ----
const BUCKETS = ['project-photos'];   // <-- change to your photo bucket name(s)
const MAX_WIDTH = 1600;               // px; plenty for job documentation
const QUALITY = 80;                   // JPEG/WebP quality
const MIN_SIZE = 600 * 1024;          // skip files already under ~600 KB

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const kb = bytes => `${Math.round(bytes / 1024)} KB`;

// Recursively list every file in a bucket (folders come back with id === null)
async function listAll(bucket, prefix = '') {
  const files = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) throw error;
    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) files.push(...await listAll(bucket, path)); // folder → recurse
      else files.push({ path, size: item.metadata?.size || 0 });
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return files;
}

// Re-encode in the same format so the file extension still matches the content
function encode(img, ext) {
  if (ext === 'png') return { buf: img.png({ compressionLevel: 9 }), type: 'image/png' };
  if (ext === 'webp') return { buf: img.webp({ quality: QUALITY }), type: 'image/webp' };
  return { buf: img.jpeg({ quality: QUALITY, mozjpeg: true }), type: 'image/jpeg' };
}

async function run() {
  console.log(APPLY ? 'APPLY MODE: files will be overwritten\n' : 'DRY RUN: nothing will change\n');
  let before = 0, after = 0, done = 0, heicCount = 0;

  for (const bucket of BUCKETS) {
    const files = await listAll(bucket);
    console.log(`${bucket}: ${files.length} files found`);

    for (const f of files) {
      if (done >= LIMIT) break;

      const ext = f.path.split('.').pop().toLowerCase();
      const isHeic = ['heic', 'heif'].includes(ext);
      if (!isHeic && !['jpg', 'jpeg', 'png', 'webp'].includes(ext)) continue; // PDFs, docs, etc. untouched
      if (!isHeic && f.size < MIN_SIZE) continue; // already small (HEIC always converted so browsers can show it)

      try {
        const { data, error } = await supabase.storage.from(bucket).download(f.path);
        if (error) throw error;
        const input = Buffer.from(await data.arrayBuffer());

        let output, type;
        if (isHeic) {
          // Decode HEIC → full-size JPEG, then resize/compress with sharp.
          // Note: heic-convert drops metadata, so date taken / GPS are lost on these.
          const jpeg = Buffer.from(await heicConvert({ buffer: input, format: 'JPEG', quality: 1 }));
          output = await sharp(jpeg)
            .resize({ width: MAX_WIDTH, withoutEnlargement: true })
            .jpeg({ quality: QUALITY, mozjpeg: true })
            .toBuffer();
          type = 'image/jpeg';
          heicCount++;
        } else {
          // rotate() applies phone orientation; withMetadata() keeps date taken / GPS
          const img = sharp(input).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true }).withMetadata();
          const enc = encode(img, ext);
          output = await enc.buf.toBuffer();
          type = enc.type;
          if (output.length >= input.length) continue; // no savings, leave it alone
        }

        before += input.length;
        after += output.length;
        done++;
        console.log(`${APPLY ? 'Resized' : 'Would resize'} ${bucket}/${f.path}: ${kb(input.length)} → ${kb(output.length)}`);

        if (APPLY) {
          const { error: upErr } = await supabase.storage
            .from(bucket)
            .upload(f.path, output, { upsert: true, contentType: type });
          if (upErr) throw upErr;
        }
      } catch (err) {
        console.log(`FAILED ${bucket}/${f.path}: ${err.message}`);
      }
    }
  }

  console.log(`\n${done} photos ${APPLY ? 'resized' : 'would be resized'}`);
  console.log(`${(before / 1024 / 1024).toFixed(1)} MB → ${(after / 1024 / 1024).toFixed(1)} MB` +
    ` (saves ${((before - after) / 1024 / 1024).toFixed(1)} MB)`);
  if (heicCount) console.log(`${heicCount} of those were HEIC → JPEG`);
}

run().catch(err => { console.error(err); process.exit(1); });