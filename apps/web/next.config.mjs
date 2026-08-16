/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@sul/shared"],
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001" },
};
