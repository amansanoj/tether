/**
 * QR Code generation using the 'qrcode' npm package.
 * Returns an image data URL (PNG) for pixel-perfect rendering.
 */

import QRCode from "qrcode";

/**
 * Generate a QR code as a data URL (PNG image).
 * Returns a promise that resolves to a data:image/png;base64,... string.
 */
export async function generateQRCodeDataURL(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    margin: 2,
    width: 256,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
    errorCorrectionLevel: "M",
  });
}
