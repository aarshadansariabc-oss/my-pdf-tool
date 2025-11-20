/**
 * server.js
 * PDF Compressor + Resizer using Ghostscript
 *
 * Requirements:
 * - Node.js
 * - npm install express multer cors
 * - Ghostscript installed (gswin64c on Windows, gs on linux/mac)
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static("./")); // serve tool.html

// Ensure uploads and output exist
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("output")) fs.mkdirSync("output");

const upload = multer({ dest: "uploads/" });

// Ghostscript executable
const GS_EXEC = process.platform === "win32" ? "gswin64c" : "gs";

/**
 * Run Ghostscript helper
 */
function runGs(args) {
  try {
    const res = spawnSync(GS_EXEC, args, { encoding: "utf8", windowsHide: true, timeout: 120000 });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    return { code: 1, stdout: "", stderr: String(err) };
  }
}

/**
 * Get file size in KB
 */
function sizeKb(p) {
  try {
    const s = fs.statSync(p).size;
    return Math.round(s / 1024);
  } catch (e) {
    return null;
  }
}

/**
 * /compress endpoint
 * Logic: Reduces Image DPI (Resolution) to meet target size.
 */
app.post("/compress", upload.single("pdf"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const input = req.file.path;
  const originalKb = Math.round(req.file.size / 1024);
  const targetKb = req.body.targetKb ? Number(req.body.targetKb) : null;
  const quality = req.body.quality ? Number(req.body.quality) : null;
  
  const basename = `compressed_${Date.now()}.pdf`;
  const output = path.join("output", basename);

  // Resolution Helper
  function qualityToResolution(q) {
    if (!q) return 150;
    if (q >= 90) return 300;
    if (q >= 75) return 200;
    if (q >= 50) return 150;
    if (q >= 25) return 100;
    return 72;
  }

  const baseArgs = (resDpi) => [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-dPDFSETTINGS=/default",
    "-dNOPAUSE", "-dQUIET", "-dBATCH",
    "-dDownsampleColorImages=true",
    "-dColorImageDownsampleType=/Bicubic",
    `-dColorImageResolution=${resDpi}`,
    "-dDownsampleGrayImages=true",
    "-dGrayImageDownsampleType=/Bicubic",
    `-dGrayImageResolution=${resDpi}`,
    `-sOutputFile=${output}`,
    input
  ];

  try {
    if (targetKb) {
      // ITERATIVE COMPRESSION (DPI Reduction)
      // Start at 200 DPI and go down
      let resDpi = 200;
      const minDpi = 40;
      let success = false;

      while (resDpi >= minDpi) {
        if (fs.existsSync(output)) fs.unlinkSync(output);
        
        const r = runGs(baseArgs(resDpi));
        if (r.code !== 0) { console.error("GS Error:", r.stderr); break; }
        
        const currentKb = sizeKb(output);
        if (currentKb && currentKb <= targetKb) {
          success = true;
          break;
        }
        
        // Reduce DPI for next loop (aggressive step down)
        resDpi = Math.floor(resDpi * 0.75);
      }

    } else {
      // SLIDER MODE
      const resDpi = qualityToResolution(quality || 75);
      if (fs.existsSync(output)) fs.unlinkSync(output);
      runGs(baseArgs(resDpi));
    }

    // Final Response
    if (!fs.existsSync(output)) throw new Error("Output generation failed");
    
    const finalKb = sizeKb(output);
    res.setHeader("X-Original-KB", originalKb);
    res.setHeader("X-Final-KB", finalKb);
    
    res.download(output, basename, () => {
      try { fs.unlinkSync(input); fs.unlinkSync(output); } catch (e) {}
    });

  } catch (err) {
    console.error(err);
    try { fs.unlinkSync(input); } catch(e){}
    res.status(500).json({ error: "Compression failed" });
  }
});


/**
 * /resize endpoint (UPDATED)
 * Logic: Reduces Page Dimensions (Scale) to meet target size.
 * Receives: targetKb (from frontend)
 */
app.post("/resize", upload.single("pdf"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const input = req.file.path;
  const basename = `resized_${Date.now()}.pdf`;
  const output = path.join("output", basename);
  
  // Frontend now sends targetKb
  const targetKb = req.body.targetKb ? Number(req.body.targetKb) : null;
  
  // Default A4 Points Reference (595 x 842)
  const BASE_W = 595;
  const BASE_H = 842;

  try {
    if (!targetKb) {
        throw new Error("Target size is required for resizing");
    }

    // ITERATIVE RESIZE LOGIC
    // Start at 100% scale (1.0) and shrink until size <= targetKb
    let scale = 1.0; 
    const minScale = 0.1; // Don't go smaller than 10% scale
    let success = false;

    while (scale >= minScale) {
      if (fs.existsSync(output)) fs.unlinkSync(output);

      const w = Math.round(BASE_W * scale);
      const h = Math.round(BASE_H * scale);

      const args = [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        `-dDEVICEWIDTHPOINTS=${w}`,
        `-dDEVICEHEIGHTPOINTS=${h}`,
        "-dPDFFitPage", // Forces content to fit new page size
        "-dNOPAUSE", "-dQUIET", "-dBATCH",
        `-sOutputFile=${output}`,
        input
      ];

      const r = runGs(args);
      if (r.code !== 0) { console.error("GS Resize Error:", r.stderr); break; }

      const currentKb = sizeKb(output);
      
      // If we hit the target or scale gets too small, stop.
      if (currentKb && currentKb <= targetKb) {
        success = true;
        break;
      }

      // Reduce scale by 10% for next iteration
      scale -= 0.10;
    }

    if (!fs.existsSync(output)) throw new Error("Resize failed to generate file");

    const finalKb = sizeKb(output);
    res.setHeader("X-Final-KB", finalKb);
    
    res.download(output, basename, () => {
      try { fs.unlinkSync(input); fs.unlinkSync(output); } catch (e) {}
    });

  } catch (err) {
    console.error(err);
    try { fs.unlinkSync(input); } catch (e) {}
    res.status(500).json({ error: err.message || "Server error" });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/tool.html`);
  console.log(`Using Ghostscript: ${GS_EXEC}`);
});