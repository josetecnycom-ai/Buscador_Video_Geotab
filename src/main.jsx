import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "@geotab/zenith/dist/index.css";
import "./styles.css";

let root;
window.__VTC_VIDEO_MOUNT__ = (api, state) => {
  if (!root) root = createRoot(document.getElementById("root"));
  root.render(<App api={api} pageState={state} />);
};
window.dispatchEvent(new CustomEvent("vtc-video-app-ready"));
