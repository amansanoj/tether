/**
 * QR Code generation using the 'qrcode' npm package.
 * Returns an SVG string for embedding in the DOM.
 */

import QRCode from "qrcode";

/**
 * Generate an SVG QR code string for the given text.
 * Returns a promise that resolves to an SVG string.
 */
export async function generateQRCodeSVG(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    margin: 2,
    width: 200,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });
}
