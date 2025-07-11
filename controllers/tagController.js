exports.processFile = async (req, res) => {
  const inputFilePath = req.file.path;
  const filename = path.basename(inputFilePath);
  const wavDir = path.join(__dirname, "..", "wavuploads");
  const wavFilePath = path.join(wavDir, `${filename}.wav`);

  try {
    if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });

    await new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -i "${inputFilePath}" -ar 44100 -ac 2 -f wav "${wavFilePath}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) return reject(new Error("FFmpeg conversion failed: " + stderr));
        resolve();
      });
    });

    const { duration, fingerprint } = await generateFingerprint(wavFilePath);

    const response = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_API_KEY,
        meta: "recordings+releasegroups+compress",
        fingerprint,
        duration,
      },
    });

    const match = response.data.results[0]?.recordings?.[0];
    const title = match?.title || "Unknown Title";
    const artist = match?.artists?.[0]?.name || "Unknown Artist";
    const album = match?.releasegroups?.[0]?.title || "Unknown Album";
    const year = match?.releasegroups?.[0]?.first_release_date?.split("-")[0] || "";
    const genre = match?.tags?.[0]?.name || "Unknown Genre";

    let image = null;
    const mbid = match?.releasegroups?.[0]?.id;
    if (mbid) {
      try {
        image = await fetchAlbumArt(mbid);
      } catch (err) {
        console.warn(`⚠️ No album art found for MBID ${mbid}`);
      }
    }

    const tags = { title, artist, album, year, genre, image };

    await writeTags(tags, inputFilePath);

    const zipPath = await zipTaggedFiles("uploads");

    res.download(zipPath, "metatune-output.zip", err => {
      if (err) {
        console.error("❌ Error sending ZIP:", err);
        res.status(500).json({ error: "Failed to send ZIP file" });
      }

      fs.unlink(zipPath, () => {});
      fs.unlink(wavFilePath, () => {});
    });
  } catch (err) {
    console.error("❌ Error in processFile:", err);
    res.status(500).json({ error: "Tagging failed", details: err.message });
  }
};
