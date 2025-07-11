const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// 🛡️ CORS Setup
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

// 🎧 Routes
const tagRoutes = require("./routes/tagRoutes");
app.use("/api/tag", tagRoutes);

// 🌐 Root health check
app.get("/", (req, res) => {
  res.send("🎧 MetaTune API is running.");
});

// 🧹 Optional Cleanup on Exit
process.on("exit", () => {
  const dir = "./uploads";
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
  }
});

// 🚀 Start Server
app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
