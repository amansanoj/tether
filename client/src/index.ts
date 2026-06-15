/**
 * Tether frontend entry point.
 * Mounts the app to #app.
 */

import { createApp } from "./App";

const root = document.getElementById("app");

if (root) {
  root.innerHTML = "";
  const app = createApp();
  root.appendChild(app);
}
