import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { readFileSync } from "node:fs";

const tauriConfig = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);

const mode = process.env.BUILD_MODE ?? "standalone";
console.log("[Next] build mode", mode);

/** @param {string} phase */
const createNextConfig = (phase) => ({
  reactCompiler: true,
  env: {
    BUILD_VERSION: tauriConfig.version,
  },
  turbopack: {
    resolveAlias:
      mode === "export"
        ? {
            "@/app/mcp/actions": "./app/mcp/actions.export.ts",
            "rt-client": "./node_modules/rt-client/dist/browser/index.js",
          }
        : {},
    rules: {
      "*.svg": {
        loaders: ["@svgr/webpack"],
        as: "*.js",
      },
    },
  },
  output:
    mode === "export" && phase !== PHASE_PRODUCTION_BUILD ? undefined : mode,
  images: {
    unoptimized: mode === "export",
  },
});

const CorsHeaders = [
  { key: "Access-Control-Allow-Credentials", value: "true" },
  { key: "Access-Control-Allow-Origin", value: "*" },
  {
    key: "Access-Control-Allow-Methods",
    value: "*",
  },
  {
    key: "Access-Control-Allow-Headers",
    value: "*",
  },
  {
    key: "Access-Control-Max-Age",
    value: "86400",
  },
];

const withServerRoutes = (nextConfig) => {
  if (mode === "export") return nextConfig;

  nextConfig.headers = async () => {
    return [
      {
        source: "/api/:path*",
        headers: CorsHeaders,
      },
    ];
  };

  nextConfig.rewrites = async () => {
    const ret = [
      // adjust for previous version directly using "/api/proxy/" as proxy base route
      // {
      //   source: "/api/proxy/v1/:path*",
      //   destination: "https://api.openai.com/v1/:path*",
      // },
      {
        // https://{resource_name}.openai.azure.com/openai/deployments/{deploy_name}/chat/completions
        source:
          "/api/proxy/azure/:resource_name/deployments/:deploy_name/:path*",
        destination:
          "https://:resource_name.openai.azure.com/openai/deployments/:deploy_name/:path*",
      },
      {
        source: "/api/proxy/google/:path*",
        destination: "https://generativelanguage.googleapis.com/:path*",
      },
      {
        source: "/api/proxy/openai/:path*",
        destination: "https://api.openai.com/:path*",
      },
      {
        source: "/api/proxy/anthropic/:path*",
        destination: "https://api.anthropic.com/:path*",
      },
      {
        source: "/google-fonts/:path*",
        destination: "https://fonts.googleapis.com/:path*",
      },
      {
        source: "/sharegpt",
        destination: "https://sharegpt.com/api/conversations",
      },
      {
        source: "/api/proxy/alibaba/:path*",
        destination: "https://dashscope.aliyuncs.com/api/:path*",
      },
    ];

    return {
      beforeFiles: ret,
    };
  };
  return nextConfig;
};

const nextConfig = (phase) => withServerRoutes(createNextConfig(phase));

export default nextConfig;
