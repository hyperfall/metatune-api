# MetaTune API

> **Intelligent Music Metadata Tagging & Audio Fingerprinting API**

MetaTune is a robust Node.js backend API that automatically identifies and tags audio files using advanced audio fingerprinting technology. It combines multiple recognition services (ACRCloud, AcoustID/MusicBrainz) with intelligent fusion scoring to deliver accurate metadata and album artwork.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

---

## 🎯 Features

### Core Functionality
- **🎵 Audio Fingerprinting**: Multi-provider fingerprint matching using ACRCloud and AcoustID
- **🏷️ Intelligent ID3 Tagging**: Automatic metadata extraction and embedding (title, artist, album, year, genre)
- **🖼️ Album Artwork**: Automatic cover art fetching from MusicBrainz Cover Art Archive
- **📦 Batch Processing**: Process multiple audio files simultaneously with ZIP download
- **🔄 Fusion Scoring**: Advanced confidence scoring system combining fingerprint, filename, and tag analysis
- **💾 Persistent Analytics**: SQLite database for tracking tagging history and statistics

### Audio Format Support
- MP3 (`.mp3`)
- FLAC (`.flac`)
- M4A/AAC (`.m4a`, `.aac`)
- WAV (`.wav`)
- OGG/Vorbis (`.ogg`, `.oga`)
- Opus (`.opus`)
- WebM Audio (`.webm`)

### Security & Performance
- **🛡️ Security Headers**: Helmet.js for HTTP security
- **⚡ Rate Limiting**: 60 requests/minute per IP
- **🗜️ Compression**: Gzip compression for responses
- **🔐 CORS Protection**: Configurable origin whitelist
- **📊 Authenticated Logs**: Basic auth-protected log viewer

---

## 📋 Table of Contents

- [Installation](#-installation)
- [Configuration](#-configuration)
- [Usage](#-usage)
- [API Endpoints](#-api-endpoints)
- [Architecture](#-architecture)
- [Docker Deployment](#-docker-deployment)
- [Development](#-development)
- [Environment Variables](#-environment-variables)
- [Project Structure](#-project-structure)
- [How It Works](#-how-it-works)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Installation

### Prerequisites

- **Node.js** >= 18.x
- **FFmpeg** (with ffprobe)
- **Chromaprint** (fpcalc tool)

### Local Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/metatune-api.git
cd metatune-api

# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Edit .env with your API credentials
nano .env

# Start the server
npm start
```

### Install System Dependencies

#### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install -y ffmpeg libchromaprint-tools
```

#### macOS
```bash
brew install ffmpeg chromaprint
```

#### Windows
Download and install:
- [FFmpeg](https://ffmpeg.org/download.html)
- [Chromaprint](https://acoustid.org/chromaprint)

---

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=3000
NODE_ENV=production

# ACRCloud Credentials (Required)
ACR_HOST=identify-eu-west-1.acrcloud.com
ACR_KEY=your_acrcloud_access_key
ACR_SECRET=your_acrcloud_secret

# AcoustID API Key (Required)
ACOUSTID_API_KEY=your_acoustid_api_key

# CORS Configuration
ALLOWED_ORIGIN=http://localhost:3000,https://yourdomain.com

# Fingerprint Settings
ACR_MAX_RESULTS=5
ACOUSTID_MAX_RESULTS=5
ARTIST_SIM_THRESHOLD=0.5

# Log Viewer Authentication
LOG_USER=admin
LOG_PASS=secure_password

# Debug Logging
DEBUG_LOGGING=false
```

### Getting API Keys

1. **ACRCloud**: Sign up at [ACRCloud Console](https://console.acrcloud.com/)
   - Create a new project
   - Get your Host, Access Key, and Secret

2. **AcoustID**: Register at [AcoustID](https://acoustid.org/api-key)
   - Submit your application
   - Receive API key via email

---

## 💻 Usage

### Single File Tagging

```bash
curl -X POST http://localhost:3000/api/tag/upload \
  -F "audio=@/path/to/song.mp3" \
  --output tagged-song.mp3
```

### Batch Processing

```bash
curl -X POST http://localhost:3000/api/tag/batch \
  -F "audio=@song1.mp3" \
  -F "audio=@song2.mp3" \
  -F "audio=@song3.mp3" \
  --output tagged-songs.zip
```

### JavaScript/Node.js Example

```javascript
const FormData = require('form-data');
const fs = require('fs');
const axios = require('axios');

const form = new FormData();
form.append('audio', fs.createReadStream('song.mp3'));

axios.post('http://localhost:3000/api/tag/upload', form, {
  headers: form.getHeaders(),
  responseType: 'stream'
})
.then(response => {
  response.data.pipe(fs.createWriteStream('tagged-song.mp3'));
})
.catch(error => console.error(error));
```

### Python Example

```python
import requests

url = 'http://localhost:3000/api/tag/upload'
files = {'audio': open('song.mp3', 'rb')}

response = requests.post(url, files=files)

if response.status_code == 200:
    with open('tagged-song.mp3', 'wb') as f:
        f.write(response.content)
```

---

## 📡 API Endpoints

### `GET /`
Health check endpoint.

**Response:**
```
🎧 MetaTune API is running.
```

---

### `POST /api/tag/upload`
Tag a single audio file.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: `audio` (file, max 15MB)

**Response:**
- Success: Tagged audio file download
- Error: JSON with error message

**Example:**
```bash
curl -X POST http://localhost:3000/api/tag/upload \
  -F "audio=@song.mp3" \
  -o tagged-song.mp3
```

---

### `POST /api/tag/batch`
Tag multiple audio files (up to 30).

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: `audio[]` (files, max 15MB each)

**Response:**
- Success: ZIP file containing all tagged files
- Error: JSON with error message

**Example:**
```bash
curl -X POST http://localhost:3000/api/tag/batch \
  -F "audio=@song1.mp3" \
  -F "audio=@song2.mp3" \
  -o tagged-batch.zip
```

---

### `GET /api/stats`
Retrieve fingerprinting statistics.

**Response:**
```json
{
  "totalProcessed": 150,
  "successRate": 0.94,
  "sources": {
    "acrcloud": 85,
    "musicbrainz": 45,
    "text-only": 20
  }
}
```

---

### `GET /logs-ui`
View internal logs (requires authentication).

**Authentication:** Basic Auth (LOG_USER/LOG_PASS)

**Response:** HTML page with log file browser

---

### `GET /logs/:dir/:file`
Download specific log file (requires authentication).

**Parameters:**
- `dir`: `cache` or `logs`
- `file`: filename

**Authentication:** Basic Auth

---

## 🏗️ Architecture

### Technology Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js 5.x
- **Audio Processing**: FFmpeg, fluent-ffmpeg
- **Fingerprinting**: Chromaprint (fpcalc), ACRCloud SDK
- **Metadata**: music-metadata, node-id3
- **Database**: SQLite3
- **Security**: Helmet, express-rate-limit, CORS
- **Utilities**: Axios, Archiver, Multer

### Recognition Flow

```
Audio File Upload
    ↓
Extract Fingerprint (fpcalc)
    ↓
Query Multiple Services
    ├─→ ACRCloud API
    ├─→ AcoustID → MusicBrainz
    └─→ Text-based Fallback
    ↓
Fusion Scoring Algorithm
    ├─→ Fingerprint Score (60%)
    ├─→ Duration Match (10%)
    ├─→ Filename Analysis (10%)
    ├─→ Tag Comparison (10%)
    └─→ Year Proximity (10%)
    ↓
Select Best Match (≥0.6 confidence)
    ↓
Fetch Album Artwork (MusicBrainz)
    ↓
Embed Metadata + Cover Art (FFmpeg)
    ↓
Return Tagged File
```

### Fusion Scoring System

The API uses a sophisticated fusion scoring algorithm that combines:

1. **Fingerprint Score** (60%): Confidence from ACRCloud/AcoustID
2. **Duration Match** (10%): Audio length comparison
3. **Filename Analysis** (10%): Artist/title extraction from filename
4. **Tag Comparison** (10%): Existing metadata validation
5. **Year Proximity** (10%): Release year matching

**Confidence Levels:**
- **High**: ≥ 0.8 (80%)
- **Medium**: 0.5 - 0.79 (50-79%)
- **Low**: < 0.5 (rejected unless only option)

---

## 🐳 Docker Deployment

### Build Image

```bash
docker build -t metatune-api .
```

### Run Container

```bash
docker run -d \
  -p 8080:8080 \
  -e ACR_HOST=your_host \
  -e ACR_KEY=your_key \
  -e ACR_SECRET=your_secret \
  -e ACOUSTID_API_KEY=your_key \
  --name metatune \
  metatune-api
```

### Docker Compose

```yaml
version: '3.8'

services:
  metatune:
    build: .
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - ACR_HOST=${ACR_HOST}
      - ACR_KEY=${ACR_KEY}
      - ACR_SECRET=${ACR_SECRET}
      - ACOUSTID_API_KEY=${ACOUSTID_API_KEY}
      - ALLOWED_ORIGIN=*
    volumes:
      - ./cache:/app/cache
      - ./logs:/app/logs
    restart: unless-stopped
```

Run with:
```bash
docker-compose up -d
```

---

## 🛠️ Development

### Development Mode

```bash
npm run dev
```

Uses `nodemon` for automatic server restart on file changes.

### Project Scripts

```json
{
  "start": "node index.js",
  "dev": "nodemon index.js"
}
```

### Testing

```bash
# Test single file upload
curl -X POST http://localhost:3000/api/tag/upload \
  -F "audio=@test/sample.mp3" \
  -o test/output.mp3

# Check stats
curl http://localhost:3000/api/stats
```

---

## 📂 Project Structure

```
metatune-api/
├── controllers/
│   └── tagController.js       # Main tagging logic
├── routes/
│   └── tagRoutes.js           # Route definitions
├── utils/
│   ├── cleanupUploads.js      # Temporary file cleanup
│   ├── db.js                  # SQLite analytics
│   ├── fetch.js               # HTTP client wrapper
│   ├── fetchAlbumArtByMetadata.js
│   ├── fetchAlbumArtFromUrl.js
│   ├── fingerprint.js         # Audio fingerprinting
│   ├── fusionScorer.js        # Match confidence scoring
│   ├── fuzzy.js               # String similarity
│   ├── logger.js              # Logging utilities
│   ├── metadataExtractor.js   # FFprobe metadata extraction
│   ├── musicbrainzHelper.js   # MusicBrainz API client
│   ├── normalizeTitle.js      # Text normalization
│   ├── tagReader.js           # ID3 tag reading
│   ├── tagWriter.js           # ID3 tag writing
│   └── zipFiles.js            # Batch ZIP creation
├── cache/                     # Fingerprint cache & stats
├── logs/                      # Processing logs
├── uploads/                   # Temporary upload directory
├── wavuploads/                # WAV conversion cache
├── zips/                      # Batch ZIP outputs
├── .dockerignore
├── Dockerfile
├── index.js                   # Express server entry point
├── package.json
└── README.md
```

---

## 🔍 How It Works

### 1. Audio Fingerprinting

The API uses **Chromaprint** (via `fpcalc`) to generate acoustic fingerprints:

```javascript
// Extract fingerprint
const fp = await runFpcalc(filePath);
// Returns: { duration: 245.3, fingerprint: "AQADtE..." }
```

### 2. Multi-Provider Lookup

Queries multiple services in parallel:

- **ACRCloud**: Commercial music recognition (high accuracy)
- **AcoustID**: Open-source fingerprinting → MusicBrainz
- **MusicBrainz**: Metadata enrichment and album art

### 3. Intelligent Matching

The fusion scorer evaluates each candidate:

```javascript
const fusionResult = scoreFusionMatch(filePath, metadata, originalTags);
// Returns: { score: 0.87, confidence: "High", debug: {...} }
```

### 4. Metadata Embedding

Uses FFmpeg to embed metadata and cover art:

```bash
ffmpeg -i input.mp3 -i cover.jpg \
  -map 0:a -map 1 \
  -metadata title="Song Title" \
  -metadata artist="Artist Name" \
  -c copy output.mp3
```

### 5. Cleanup & Logging

- Temporary files auto-deleted after 15 minutes
- All matches logged to SQLite database
- Debug logs saved to `cache/` and `logs/`

---

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Code Style

- Use ES6+ features
- Follow existing code formatting
- Add comments for complex logic
- Update documentation for new features

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- **ACRCloud** - Audio recognition service
- **AcoustID** - Open-source audio fingerprinting
- **MusicBrainz** - Open music encyclopedia
- **Chromaprint** - Audio fingerprint library
- **FFmpeg** - Multimedia processing framework

---

## 📧 Contact

**Author**: Noctark  
**Project Link**: [https://github.com/yourusername/metatune-api](https://github.com/yourusername/metatune-api)

---

## 🐛 Troubleshooting

### Common Issues

**"ACRCloud credentials are missing!"**
- Ensure `.env` file contains valid ACR_HOST, ACR_KEY, and ACR_SECRET

**"fpcalc: command not found"**
- Install Chromaprint: `sudo apt-get install libchromaprint-tools`

**"No match found"**
- File may be too obscure or low quality
- Try with higher bitrate audio
- Check if file is actually music (not speech/noise)

**Rate limit exceeded**
- Default: 60 requests/minute per IP
- Adjust in `index.js` rate limiter configuration

**Upload fails**
- Check file size (max 15MB per file)
- Verify audio format is supported
- Ensure FFmpeg is installed

---

## 🔮 Roadmap

- [ ] Support for additional audio formats (APE, DSD)
- [ ] Lyrics fetching and embedding
- [ ] Genre classification using ML
- [ ] Duplicate detection
- [ ] Playlist generation
- [ ] Web UI dashboard
- [ ] Spotify/Apple Music integration
- [ ] Real-time processing via WebSocket

---

**Made with ❤️ for music lovers**
