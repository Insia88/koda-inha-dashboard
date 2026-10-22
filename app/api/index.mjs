// Vercel Node 함수(모든 /api/* 요청이 이곳으로 다시 쓰인다). 빌드 산출물 .vercel-server/handler.mjs는
// `npm run build:vercel`(vite build + esbuild로 server/vercel.ts 묶기)이 만든다. 이 파일은 손으로 고치지 않는다.
export { default } from '../.vercel-server/handler.mjs';
