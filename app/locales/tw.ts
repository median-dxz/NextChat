import { getClientConfig } from "../config/client";
import { SubmitKey } from "../store/config";
import { SAAS_CHAT_UTM_URL } from "@/app/constant";
import type { PartialLocaleType } from "./en";
const isApp = !!getClientConfig()?.isApp;

const tw: PartialLocaleType = {
  Error: {
    Unauthorized: isApp
      ? `😆 對話遇到了一些問題，不用慌:
    \\ 1️⃣ 想要無須設定開箱即用，[點選這裡立刻開啟對話 🚀](${SAAS_CHAT_UTM_URL})
    \\ 2️⃣ 如果你想消耗自己的 OpenAI 資源，點選[這裡](/#/settings)修改設定 ⚙️`
      : `😆 對話遇到了一些問題，不用慌:
    \ 1️⃣ 想要無須設定開箱即用，[點選這裡立刻開啟對話 🚀](${SAAS_CHAT_UTM_URL})
    \ 2️⃣ 如果你正在使用私有部署版本，點選[這裡](/#/auth)輸入存取金鑰 🔑
    \ 3️⃣ 如果你想消耗自己的 OpenAI 資源，點選[這裡](/#/settings)修改設定 ⚙️
 `,
  },

  Auth: {
    Title: "需要密碼",
    Tips: "管理員開啟了密碼驗證，請在下方填入存取密碼",
    SubTips: "或者輸入你的 OpenAI 或 Google API 金鑰",
    Input: "在此處填寫存取密碼",
    Confirm: "確認",
    Return: "返回",
    SaasTips: "設定太麻煩，想要立即使用",
    TopTips:
      "🥳 NextChat AI 首發優惠，立刻解鎖 OpenAI o1, GPT-4o, Claude-3.5 等最新的大型語言模型",
  },
  ChatItem: {
    ChatItemCount: (count: number) => `${count} 則對話`,
  },
  Chat: {
    SubTitle: (count: number) => `您已經與 ChatGPT 進行了 ${count} 則對話`,
    EditMessage: {
      Title: "編輯訊息記錄",
      Topic: {
        Title: "聊天主題",
        SubTitle: "更改目前聊天主題",
      },
    },
    Actions: {
      ChatList: "檢視訊息列表",
      Export: "匯出聊天紀錄",
      Copy: "複製",
      Stop: "停止",
      Retry: "重試",
      PinToastContent: "已將 1 條對話固定至預設提示詞",
      PinToastAction: "檢視",
      Delete: "刪除",
      Edit: "編輯",
      RefreshTitle: "重新整理標題",
      RefreshToast: "已傳送重新整理標題請求",
    },
    Commands: {
      new: "新建聊天",
      newm: "從角色範本新建聊天",
      next: "下一個聊天",
      prev: "上一個聊天",
      del: "刪除聊天",
    },
    InputActions: {
      Stop: "停止回應",
      ToBottom: "移至最新",
      Theme: {
        auto: "自動主題",
        light: "亮色模式",
        dark: "深色模式",
      },
      Prompt: "快捷指令",
      Masks: "所有角色範本",
      Settings: "對話設定",
      UploadImage: "上傳圖片",
    },
    Typing: "正在輸入…",
    Input: (submitKey: string) => {
      var inputHints = `輸入訊息後，按下 ${submitKey} 鍵即可傳送`;
      if (submitKey === String(SubmitKey.Enter)) {
        inputHints += "，Shift + Enter 鍵換行";
      }
      return inputHints;
    },
    Send: "傳送",
    Config: {
      SaveAs: "另存新檔",
    },
    IsContext: "預設提示詞",
    ShortcutKey: {
      Title: "鍵盤快捷方式",
      newChat: "開啟新聊天",
      focusInput: "聚焦輸入框",
      copyLastMessage: "複製最後一個回覆",
      copyLastCode: "複製最後一個程式碼區塊",
      showShortcutKey: "顯示快捷方式",
    },
  },
  Export: {
    Title: "將聊天記錄匯出為 Markdown",
    Copy: "複製全部",
    Download: "下載檔案",
    MessageFromYou: "來自您的訊息",
    MessageFromChatGPT: "來自 ChatGPT 的訊息",
    Format: {
      Title: "匯出格式",
      SubTitle: "可以匯出 Markdown 文字檔或者 PNG 圖片",
    },
    IncludeContext: {
      Title: "包含角色範本上下文",
      SubTitle: "是否在訊息中顯示角色範本上下文",
    },
    Steps: {
      Select: "選取",
      Preview: "預覽",
    },
    Image: {
      Toast: "正在產生截圖",
      Modal: "長按或按右鍵儲存圖片",
    },
  },
  Select: {
    Search: "查詢訊息",
    All: "選取全部",
    Latest: "最近幾條",
    Clear: "清除選取",
  },
  Memory: {
    Title: "對話摘要",
    Send: "自動摘要聊天記錄並納入上下文",
  },
  Home: {
    NewChat: "開新對話",
    DeleteChat: "確定要刪除選取的對話嗎？",
    DeleteToast: "已刪除對話",
    Revert: "撤銷",
  },
  Settings: {
    Title: "設定",
    SubTitle: "設定選項",

    Danger: {
      Reset: {
        Title: "重設所有設定",
        SubTitle: "重設所有設定項回預設值",
        Action: "立即重設",
        Confirm: "確認重設所有設定？",
      },
      Clear: {
        Title: "清除所有資料",
        SubTitle: "清除所有聊天、設定資料",
        Action: "立即清除",
        Confirm: "確認清除所有聊天、設定資料？",
      },
    },
    Lang: {
      Name: "Language", // ATTENTION: if you wanna add a new translation, please do not translate this value, leave it as `Language`
      All: "所有語言",
    },
    Avatar: "大頭貼",
    FontSize: {
      Title: "字型大小",
      SubTitle: "聊天內容的字型大小",
    },
    FontFamily: {
      Title: "聊天字型",
      SubTitle: "聊天內容的字型，若留空則套用全域預設字型",
      Placeholder: "字型名稱",
    },
    InjectSystemPrompts: {
      Title: "匯入系統提示",
      SubTitle: "強制在每個請求的訊息列表開頭新增一個模擬 ChatGPT 的系統提示",
    },
    InputTemplate: {
      Title: "使用者輸入預處理",
      SubTitle: "使用者最新的一則訊息會填充到此範本",
    },

    Update: {
      Version: (x: string) => `目前版本：${x}`,
      IsLatest: "已是最新版本",
      CheckUpdate: "檢查更新",
      IsChecking: "正在檢查更新...",
      FoundUpdate: (x: string) => `發現新版本：${x}`,
      GoToUpdate: "前往更新",
    },
    SendKey: "傳送鍵",
    Theme: "主題",
    SendPreviewBubble: {
      Title: "預覽氣泡",
      SubTitle: "在預覽氣泡中預覽 Markdown 內容",
    },
    AutoGenerateTitle: {
      Title: "自動產生標題",
      SubTitle: "根據對話內容產生合適的標題",
    },
    Sync: {
      CloudState: "雲端資料",
      NotSyncYet: "還沒有進行過同步",
      Success: "同步成功",
      Fail: "同步失敗",

      Config: {
        Modal: {
          Title: "設定雲端同步",
          Check: "檢查可用性",
        },
        SyncType: {
          Title: "同步類型",
          SubTitle: "選擇偏好的同步伺服器",
        },
        Proxy: {
          Title: "啟用代理伺服器",
          SubTitle: "在瀏覽器中同步時，啟用代理伺服器以避免跨域限制",
        },
        ProxyUrl: {
          Title: "代理伺服器位置",
          SubTitle: "僅適用於本專案內建的跨域代理",
        },

        WebDav: {
          Endpoint: "WebDAV 位置",
          UserName: "使用者名稱",
          Password: "密碼",
        },

        UpStash: {
          Endpoint: "UpStash Redis REST Url",
          UserName: "備份名稱",
          Password: "UpStash Redis REST Token",
        },
      },

      LocalState: "本機資料",
      Overview: (overview: any) => {
        return `${overview.chat} 次對話，${overview.message} 則訊息，${overview.prompt} 條提示詞，${overview.mask} 個角色範本`;
      },
      ImportFailed: "匯入失敗",
    },
    Mask: {
      Splash: {
        Title: "角色範本啟動頁面",
        SubTitle: "新增聊天時，呈現角色範本啟動頁面",
      },
      Builtin: {
        Title: "隱藏內建角色範本",
        SubTitle: "在所有角色範本列表中隱藏內建角色範本",
      },
    },
    Prompt: {
      Disable: {
        Title: "停用提示詞自動補齊",
        SubTitle: "在輸入框開頭輸入 / 即可觸發自動補齊",
      },
      List: "自訂提示詞列表",
      ListCount: (builtin: number, custom: number) =>
        `內建 ${builtin} 條，使用者自訂 ${custom} 條`,
      Edit: "編輯",
      Modal: {
        Title: "提示詞列表",
        Add: "新增一則",
        Search: "搜尋提示詞",
      },
      EditModal: {
        Title: "編輯提示詞",
      },
    },
    HistoryCount: {
      Title: "近期原文節點數",
      SubTitle: "每次請求優先保留的近期原始對話節點數",
    },
    CompressThreshold: {
      Title: "Segment 來源 Token 目標",
      SubTitle: "同級鏈未分段原文達到該目標時建立局部摘要",
    },

    Usage: {
      Title: "帳戶餘額",
      SubTitle(used: any, total: any) {
        return `本月已使用 $${used}，訂閱總額 $${total}`;
      },
      IsChecking: "正在檢查…",
      Check: "重新檢查",
      NoAccess: "輸入 API Key 檢視餘額",
    },

    Access: {
      SaasStart: {
        Title: "使用 NextChat AI",
        Label: "(性價比最高的方案)",
        SubTitle:
          "由 NextChat 官方維護，無須設定開箱即用，支援 OpenAI o1、GPT-4o、Claude-3.5 等最新的大型語言模型",
        ChatNow: "立刻開始對話",
      },

      AccessCode: {
        Title: "存取密碼",
        SubTitle: "管理員已開啟加密存取",
        Placeholder: "請輸入存取密碼",
      },
      CustomEndpoint: {
        Title: "自訂 API 端點 (Endpoint)",
        SubTitle: "是否使用自訂 Azure 或 OpenAI 服務",
      },
      Provider: {
        Title: "模型供應商",
        SubTitle: "切換不同的服務供應商",
      },
      OpenAI: {
        ApiKey: {
          Title: "API Key",
          SubTitle: "使用自訂 OpenAI Key 繞過密碼存取限制",
          Placeholder: "OpenAI API Key",
        },

        Endpoint: {
          Title: "API 端點 (Endpoint) 位址",
          SubTitle: "除預設位址外，必須包含 http(s)://",
        },
      },
      Azure: {
        ApiKey: {
          Title: "API 金鑰",
          SubTitle: "使用自訂 Azure Key 繞過密碼存取限制",
          Placeholder: "Azure API Key",
        },

        Endpoint: {
          Title: "API 端點 (Endpoint) 位址",
          SubTitle: "範例：",
        },

        ApiVerion: {
          Title: "API 版本 (azure api version)",
          SubTitle: "指定一個特定的 API 版本",
        },
      },
      Anthropic: {
        ApiKey: {
          Title: "API 金鑰",
          SubTitle: "從 Anthropic AI 取得您的 API 金鑰",
          Placeholder: "Anthropic API Key",
        },

        Endpoint: {
          Title: "端點位址",
          SubTitle: "範例：",
        },

        ApiVerion: {
          Title: "API 版本 (claude api version)",
          SubTitle: "指定一個特定的 API 版本",
        },
      },
      Google: {
        ApiKey: {
          Title: "API 金鑰",
          SubTitle: "從 Google AI 取得您的 API 金鑰",
          Placeholder: "輸入您的 Google AI Studio API 金鑰",
        },

        Endpoint: {
          Title: "端點位址",
          SubTitle: "範例：",
        },

        ApiVersion: {
          Title: "API 版本（僅適用於 gemini-pro）",
          SubTitle: "選擇一個特定的 API 版本",
        },
      },
      AI302: {
        ApiKey: {
          Title: "API 金鑰",
          SubTitle: "使用自訂 302.AI API 金鑰",
          Placeholder: "302.AI API 金鑰",
        },
        Endpoint: {
          Title: "端點位址",
          SubTitle: "範例：",
        },
      },
      CustomModel: {
        Title: "自訂模型名稱",
        SubTitle: "增加自訂模型可選擇項目，使用英文逗號隔開",
      },
    },

    Model: "模型 (model)",
    CompressModel: {
      Title: "壓縮模型",
      SubTitle: "用於壓縮歷史記錄的模型",
    },
    Temperature: {
      Title: "隨機性 (temperature)",
      SubTitle: "值越大，回應越隨機",
    },
    TopP: {
      Title: "核心採樣 (top_p)",
      SubTitle: "與隨機性類似，但不要和隨機性一起更改",
    },
    MaxTokens: {
      Title: "單次回應限制 (max_tokens)",
      SubTitle: "單次互動所用的最大 Token 數",
    },
    PresencePenalty: {
      Title: "話題新穎度 (presence_penalty)",
      SubTitle: "值越大，越有可能拓展到新話題",
    },
    FrequencyPenalty: {
      Title: "頻率懲罰度 (frequency_penalty)",
      SubTitle: "值越大，越有可能降低重複字詞",
    },
  },
  Store: {
    DefaultTopic: "新的對話",
    BotHello: "請問需要我的協助嗎？",
    Prompt: {
      Topic:
        "Use the language used by the user (e.g. en for english conversation, zh-hant for chinese conversation, etc.) to generate a title (at most 6 words) summarizing our conversation without any lead-in, quotation marks, preamble like 'Title:', direct text copies, single-word replies, quotation marks, translations, or brackets. Remove enclosing quotation marks. The title should make third-party grasp the essence of the conversation in first sight.",
      Summarize:
        "Use the language used by the user (e.g. en-us for english conversation, zh-hant for chinese conversation, etc.) to summarise the conversation in at most 200 words. The summary will be used as prompt for you to continue the conversation in the future.",
    },
  },
  Copy: {
    Success: "已複製到剪貼簿中",
    Failed: "複製失敗，請賦予剪貼簿權限",
  },
  Download: {
    Success: "內容已下載到您的目錄。",
    Failed: "下載失敗。",
  },
  Context: {
    Toast: (x: any) => `已設定 ${x} 條前置上下文`,
    Edit: "前置上下文和歷史記憶",
    Add: "新增一則",
  },
  Plugin: { Name: "外掛" },
  FineTuned: { Sysmessage: "你是一個助手" },
  Mask: {
    Name: "角色範本",
    Page: {
      Title: "預設角色角色範本",
      SubTitle: (count: number) => `${count} 個預設角色定義`,
      Search: "搜尋角色角色範本",
      Create: "新增",
    },
    Item: {
      Info: (count: number) => `包含 ${count} 條預設對話`,
      Chat: "對話",
      View: "檢視",
      Edit: "編輯",
      Delete: "刪除",
      DeleteConfirm: "確認刪除？",
    },
    EditModal: {
      Title: (readonly: boolean) =>
        `編輯預設角色範本 ${readonly ? "（唯讀）" : ""}`,
      Download: "下載預設值",
      Clone: "以此預設值建立副本",
    },
    Config: {
      Avatar: "角色頭像",
      Name: "角色名稱",
      Sync: {
        Title: "使用全域設定",
        SubTitle: "目前對話是否使用全域模型設定",
        Confirm: "目前對話的自訂設定將會被自動覆蓋，確認啟用全域設定？",
      },
      HideContext: {
        Title: "隱藏預設對話",
        SubTitle: "隱藏後預設對話不會出現在聊天介面",
      },
      Share: {
        Title: "分享此角色範本",
        SubTitle: "產生此角色範本的直達連結",
        Action: "複製連結",
      },
    },
  },
  SearchChat: {
    Page: {
      Title: "搜尋聊天記錄",
      Search: "輸入搜尋關鍵詞",

      SubTitle: (count: number) => `找到 ${count} 條結果`,
    },
    Item: {
      View: "檢視",
    },
  },
  NewChat: {
    Return: "返回",
    Skip: "跳過",
    NotShow: "不再顯示",
    ConfirmNoShow: "確認停用？停用後可以隨時在設定中重新啟用。",
    Title: "挑選一個角色範本",
    SubTitle: "現在開始，與角色範本背後的靈魂思維碰撞",
    More: "搜尋更多",
  },
  URLCommand: {
    Code: "偵測到連結中已經包含存取密碼，是否自動填入？",
    Settings: "偵測到連結中包含了預設設定，是否自動填入？",
  },
  UI: {
    Confirm: "確認",
    Cancel: "取消",
    Close: "關閉",
    Export: "匯出",
    Import: "匯入",
    Sync: "同步",
    Config: "設定",
  },
  Exporter: {
    Description: {
      Title: "選擇要匯出的訊息",
    },
    Model: "模型",
    Messages: "訊息",
    Topic: "主題",
    Time: "時間",
  },
};

export default tw;
// Translated by @chunkiuuu, feel free the submit new pr if there are typo/incorrect translations :D
