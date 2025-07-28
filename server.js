import express from "express";
import handler from "./index.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

app.all("/sync", (req, res) => handler(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));