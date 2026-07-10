import {
  DEFAULT_MCP_CONFIG,
  type McpRequestMessage,
  type ServerConfig,
} from "./types";

const unavailable = () => {
  throw new Error("MCP server actions are unavailable in static exports");
};

export async function getClientsStatus() {
  return {};
}

export async function getClientTools() {
  return null;
}

export async function getAvailableClientsCount() {
  return 0;
}

export async function getAllTools() {
  return [];
}

export async function initializeMcpSystem() {
  return undefined;
}

export async function addMcpServer(_clientId: string, _config: ServerConfig) {
  return unavailable();
}

export async function pauseMcpServer(_clientId: string) {
  return unavailable();
}

export async function resumeMcpServer(_clientId: string) {
  return unavailable();
}

export async function removeMcpServer(_clientId: string) {
  return unavailable();
}

export async function restartAllClients() {
  return unavailable();
}

export async function executeMcpAction(
  _clientId: string,
  _request: McpRequestMessage,
) {
  return unavailable();
}

export async function getMcpConfigFromFile() {
  return DEFAULT_MCP_CONFIG;
}

export async function isMcpEnabled() {
  return false;
}
