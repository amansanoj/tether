/**
 * Tether frontend entry point.
 *
 * This is a minimal bootstrap that will be replaced with full Solid.js
 * components once dependencies are installed and the Vite build is configured.
 */

const app = document.getElementById("app");

if (app) {
  app.innerHTML = `
    <div style="text-align: center; padding: 2rem;">
      <h1 style="font-size: 2.5rem; margin-bottom: 1rem; color: #e0e0e0;">Tether</h1>
      <p style="color: #aaa; margin-bottom: 2rem;">Watch party server</p>
      <div style="background: #1a1a2e; border-radius: 12px; padding: 2rem; max-width: 400px; margin: 0 auto;">
        <p style="color: #888; font-size: 0.9rem;">Frontend shell loaded successfully</p>
      </div>
    </div>
  `;
}
