import { ImageResponse } from "next/og";
import { MendedHeart } from "@/lib/brandMark";

export const alt = "RetailStore_2n — Beautifully Secondhand";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#fdf6f0",
        }}
      >
        <MendedHeart size={140} />

        <div
          style={{
            marginTop: 36,
            fontSize: 72,
            fontWeight: 600,
            color: "#453734",
            letterSpacing: -1,
            display: "flex",
          }}
        >
          RetailStore_2n
        </div>

        <div
          style={{
            marginTop: 16,
            fontSize: 28,
            color: "#756456",
            display: "flex",
          }}
        >
          Beautifully secondhand.
        </div>
      </div>
    ),
    { ...size }
  );
}
