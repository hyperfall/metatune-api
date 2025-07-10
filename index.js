// index.js
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const axios = require("axios");
const NodeID3 = require("node-id3");
require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());

