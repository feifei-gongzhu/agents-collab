import React from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./Shell.js";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(<Shell />);
