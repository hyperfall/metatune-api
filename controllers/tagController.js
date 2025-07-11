// controllers/tagController.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const util = require("util");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt      = require("../utils/fetchAlbumArt");
const { writeTags }      = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");
const tagReader          = require("../utils/tagReader");

const MB_BASE    = "https://musicbrainz.org/ws/2";
const MB_HEADERS = { "User-Agent": "MetaTune/1.0 (you@domain.com)" };
const clean = s =>
  (s || "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s{2,}/g, " ").trim() || "Unknown";

async function handleTagging(files) {
  const out = [];

  for (const file of files) {
    const orig = file.originalname;
    const p    = file.path;
    console.log(`\n⏳ Tagging: ${orig}`);

    try {
      // 1️⃣ get fingerprint & duration (utils/fingerprint handles its own wav conversion)
      const { duration, fingerprint } = await generateFingerprint(p);
      console.log("  🎵 fingerprint & duration ready");

      // 2️⃣ fetch AcoustID results
      const ac = await axios.get("https://api.acoustid.org/v2/lookup", {
        params: {
          client:   process.env.ACOUSTID_API_KEY,
          meta:     "recordings+releasegroups+compress",
          fingerprint,
          duration,
        },
      });
      const resultsArr = ac.data.results || [];
      console.log("  🎯 AcoustID scores:",
        resultsArr.map(r=>({id:r.id,score:r.score, recs:(r.recordings||[]).length}))
      );

      // 3️⃣ flatten & pick best recording
      let rec = null;
      const scored = [];
      for (const r of resultsArr) {
        (r.recordings||[]).forEach(rObj => scored.push({ rec:rObj, score:r.score }));
      }
      if (scored.length) {
        scored.sort((a,b)=>b.score-a.score);
        rec = scored[0].rec;
        console.log("  ✅ Chosen rec:", rec.id, "score", scored[0].score);
      } else {
        console.warn("  ⚠️ No recordings in AcoustID results");
      }

      // 4️⃣ if no rec, fallback to MB search by filename
      if (!rec) {
        console.log("  🔍 Filename MB fallback");
        const ext = path.extname(orig) || "";
        const nameOnly = orig.replace(ext,"");
        let [t, a] = nameOnly.split(" - ");
        if (!a) { const parts=nameOnly.split(" "); t=parts.shift(); a=parts.join(" "); }
        const sr = await axios.get(`${MB_BASE}/recording`, {
          params: { query:`recording:"${t}" AND artist:"${a}"`, fmt:"json", limit:1 },
          headers: MB_HEADERS
        });
        const f = sr.data.recordings?.[0];
        if (f?.id) {
          const lu = await axios.get(`${MB_BASE}/recording/${f.id}`, {
            params:{inc:"artists+release-groups+tags",fmt:"json"},
            headers:MB_HEADERS
          });
          rec = lu.data;
          console.log("  ✅ MB fallback rec:",rec.id);
        }
      }

      // 5️⃣ read embedded tags
      const embedded = await tagReader(p).catch(e=>{
        console.warn("  ⚠️ tagReader err:",e.message);
        return {};
      });
      console.log("  📋 Embedded tags:", { t:embedded.title, a:embedded.artist });

      // 6️⃣ merge metadata
      const title  = rec?.title
        || embedded.title || "Unknown Title";
      const artist = rec?.["artist-credit"]
        ? rec["artist-credit"].map(x=>x.name).join(", ")
        : (embedded.artist || "Unknown Artist");
      const groups = rec?.releasegroups||rec?.["release-groups"]||[];
      const rg     = groups[0]||{};
      const album  = rg.title || embedded.album || "Unknown Album";
      const year   = (rg["first-release-date"]||rg.first_release_date||"").split("-")[0]
        || embedded.year||"";
      const genre  = rec?.tags?.[0]?.name || embedded.genre||"";
      console.log("  📦 Final meta:",{title,artist,album,year,genre});

      // 7️⃣ cover art
      let image=null;
      if(rg.id){
        image = await fetchAlbumArt(rg.id).catch(e=>{
          console.warn("  ⚠️ fetchAlbumArt err:",e.message);
          return null;
        });
      }
      if(!image && embedded.image){
        image=embedded.image;
        console.log("  🎨 using embedded art");
      }

      // 8️⃣ write tags + art
      await writeTags({title,artist,album,year,genre,image},p);
      console.log("  ✅ writeTags OK");

      // 9️⃣ rename
      const ext2 = path.extname(orig)||".mp3";
      const final = `${clean(artist)} - ${clean(title)}${ext2}`;
      const finalPath = path.join(path.dirname(p),final);
      fs.renameSync(p,finalPath);
      console.log("  🏷️ Renamed to:",final);

      out.push(finalPath);
    } catch(err) {
      console.error("  ❌ failed:",err);
    }
  }

  return out;
}

exports.processFile = async (req,res)=>{
  const file = req.file;
  if(!file) return res.status(400).json({error:"No file"});
  const [out] = await handleTagging([file]);
  if(!out) return res.status(500).json({error:"Tagging failed"});
  res.download(out,path.basename(out),e=>{
    if(e) res.status(500).json({error:"Download err"});
  });
};

exports.processBatch = async (req,res)=>{
  const files = req.files||[];
  if(!files.length) return res.status(400).json({error:"No files"});
  const tagged = await handleTagging(files);
  if(!tagged.length) return res.status(500).json({error:"All failed"});
  const zip = await zipTaggedFiles(tagged);
  res.download(zip,"metatune-output.zip",e=>{
    if(e) return res.status(500).json({error:"ZIP err"});
    fs.unlinkSync(zip);
  });
};
