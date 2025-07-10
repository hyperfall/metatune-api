const express = require("express");
const multer = require("multer");
const router = express.Router();
const { processFile } = require("../controllers/tagController");

const upload = multer({ dest: "uploads/" });

router.post("/upload", upload.single("audio"), processFile);

module.exports = router;

