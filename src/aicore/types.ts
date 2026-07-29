export interface ServiceKey {
  clientid: string;
  clientsecret: string;
  url: string;
  serviceurls: { AI_API_URL: string };
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface AssistantMessage extends Message {
  role: "assistant";
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}
