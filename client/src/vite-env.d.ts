/// <reference types="vite/client" />

declare const __PANEL_VERSION__: string;
declare const __PANEL_BUILD_SHA__: string;
declare const __PANEL_API_CONTRACT_VERSION__: number;

declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

declare module '*.svg' {
  const content: string;
  export default content;
}
