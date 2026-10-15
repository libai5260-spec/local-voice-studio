// Browser-only audio project: server-side image processing is intentionally unused.
export default function unavailableSharp() {
  throw new Error("Server-side image processing is not available in this browser-only app.");
}
