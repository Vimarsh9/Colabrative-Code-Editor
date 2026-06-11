import express from "express";
import http from "http";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Recreate __filename and __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import Models (Ensure these files exist in src/models/)
import { Project } from "./models/Project";
import { File } from "./models/File";

// 1. Initialize Configuration
dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000; // ✅ FIX: Use Render's PORT

// 2. Middleware
app.use(cors({
  origin: "*", // Allow all origins (frontend)
  methods: ["GET", "POST", "DELETE", "PATCH"],
  credentials: true
}));
app.use(express.json());

// 3. MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/nexus-ide";

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("💾 Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// 4. Redis Setup (For Real-time Collaboration)
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
console.log(`🔌 Connecting to Redis at: ${REDIS_URL}`);

const pubClient = new Redis(REDIS_URL);
const subClient = pubClient.duplicate();

pubClient.on("error", (err) => console.error("❌ Redis Pub Error:", err));
subClient.on("error", (err) => console.error("❌ Redis Sub Error:", err));

const RUNTIMES: Record<string, { extension: string; getCommand: (filePath: string, dir: string) => string }> = {
  javascript: { extension: "js", getCommand: (filePath) => `node "${filePath}"` },
  python: { extension: "py", getCommand: (filePath) => `python3 "${filePath}"` },
  cpp: { extension: "cpp", getCommand: (filePath, dir) => `g++ "${filePath}" -o "${dir}/a.out" && "${dir}/a.out"` },
  java: { extension: "java", getCommand: (filePath, dir) => `javac "${filePath}" && cd "${dir}" && java Main` },
};

// ==========================================
// 🚀 API ROUTES
// ==========================================

// GET: Fetch Project Details
app.get("/projects/:projectId", async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

// GET: All Projects for User
app.get("/projects/user/:userId", async (req, res) => {
  try {
    const projects = await Project.find({ ownerId: req.params.userId }).sort({ createdAt: -1 });
    res.json(projects);
  } catch (err) {
    console.error("❌ Database query error:", err); // <--- YOU NEED THIS LINE
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// POST: Create New Project
app.post("/projects/create", async (req, res) => {
  const { name, userId } = req.body;
  if (!userId) return res.status(400).json({ error: "User ID is required" });

  try {
    const projectName = name || `Untitled Project ${Date.now()}`;
    const project = await Project.create({ name: projectName, ownerId: userId });

    // Create default file
    await File.create({
      name: "index.js",
      projectId: project._id,
      language: "javascript",
      content: "console.log('Welcome to NexusIDE!');",
    });

    res.json(project);
  } catch (error) {
    res.status(500).json({ error: "Failed to create project" });
  }
});

// PATCH: Rename Project
app.patch("/projects/:projectId", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });

    const updatedProject = await Project.findByIdAndUpdate(
      req.params.projectId,
      { name },
      { new: true }
    );
    res.json(updatedProject);
  } catch (err) {
    res.status(500).json({ error: "Failed to rename project" });
  }
});

// DELETE: Delete Project
app.delete("/projects/:projectId", async (req, res) => {
  try {
    await File.deleteMany({ projectId: req.params.projectId });
    await Project.findByIdAndDelete(req.params.projectId);
    res.json({ message: "Project deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// GET: Fetch Project Files
app.get("/projects/:projectId/files", async (req, res) => {
  try {
    const files = await File.find({ projectId: req.params.projectId });
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});

// POST: Create File
app.post("/projects/:projectId/files", async (req, res) => {
  const { name, language } = req.body;
  try {
    const newFile = await File.create({
      name,
      projectId: req.params.projectId,
      language: language || "javascript",
      content: "// Start coding...",
    });
    res.json(newFile);
  } catch (err) {
    res.status(500).json({ error: "Failed to create file" });
  }
});

// DELETE: Delete File
app.delete("/projects/:projectId/files/:fileId", async (req, res) => {
  try {
    await File.findByIdAndDelete(req.params.fileId);
    res.json({ message: "File deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete file" });
  }
});

// POST: Execute Code (⚠️ Docker Required)
app.post("/execute", async (req, res) => {
  const { code, language } = req.body;
  const runtime = RUNTIMES[language];

  if (!runtime) return res.status(400).json({ error: "Unsupported language" });

  try {
    const tempDir = path.join(__dirname, "temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // Generate a unique folder for each execution
    const executionId = Date.now().toString();
    const executionDir = path.join(tempDir, executionId);
    fs.mkdirSync(executionDir, { recursive: true });

    const fileName = language === "java" ? "Main.java" : `code.${runtime.extension}`;
    const filePath = path.join(executionDir, fileName);
    
    fs.writeFileSync(filePath, code);

    const command = runtime.getCommand(filePath, executionDir);
    console.log(`⚡ Executing: ${language}`);

    exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
      // Cleanup the unique execution folder
      try { fs.rmSync(executionDir, { recursive: true, force: true }); } catch (e) {}

      if (error) {
        console.error("Execution Error:", stderr);
        return res.json({ output: stderr || error.message });
      }
      res.json({ output: stdout });
    });
  } catch (err: any) {
    res.status(500).json({ error: "Execution failed: " + err.message });
  }
});

// ==========================================
// 🔌 SOCKET.IO SERVER (Real-time Collaboration)
// ==========================================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  adapter: createAdapter(pubClient, subClient), // Redis Adapter
});

io.on("connection", (socket) => {
  console.log(`👤 User connected: ${socket.id}`);

  socket.on("join-project", (projectId) => {
    socket.join(projectId);
    console.log(`User ${socket.id} joined project ${projectId}`);
  });

  socket.on("code-update", (data) => {
    socket.to(data.projectId).emit("code-update", data);
  });
  
  socket.on("cursor-update", (data) => {
    socket.to(data.projectId).emit("cursor-update", data);
  });

  socket.on("send-message", (data) => {
    socket.to(data.projectId).emit("receive-message", data);
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// ==========================================
// 🚀 START SERVER
// ==========================================
server.listen(PORT, () => {
  console.log(`
  🚀 Server is running!
  ---------------------
  📡 PORT:   ${PORT}
  💾 Mongo:  ${MONGO_URI.includes("localhost") ? "Local" : "Atlas"}  <-- FIXED TYPO HERE
  🔌 Redis:  ${REDIS_URL.includes("localhost") ? "Local" : "Cloud"}
  ---------------------
  `);
});