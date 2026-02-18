"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Image from "next/image";
import {
  getAssistantAvatarChangedEventName,
  loadAssistantAvatarSetting,
} from "../lib/assistantSettings";
import { getAssistantHelp, getMenuSuggestion } from "../lib/aiAssistantClient";

const MENU_AI_REQUEST_EVENT = "planotto:request-menu-ai";
const MENU_AI_STATUS_EVENT = "planotto:menu-ai-status";
const MOBILE_MENU_TOGGLE_EVENT = "planotto:mobile-menu-toggle";
const PLANOTTO_HINTS_DISABLED_KEY = "planottoHintsDisabled";
const PLANOTTO_WELCOME_SEEN_KEY = "planottoWelcomeSeen";
const PLANOTTO_PAGE_HINTS_KEY = "planottoPageHintsSeen";
const IGNORED_STATUS_MESSAGES = new Set(["Слушаю вас...", "Вопрос отправлен. Жду ответ..."]);

type SpeechRecognitionResultEventLike = {
  results?: ArrayLike<ArrayLike<{ transcript?: string }>>;
};

type SpeechRecognitionErrorEventLike = {
  error?: string;
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous?: boolean;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onstart?: (() => void) | null;
  onnomatch?: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop?: () => void;
  abort?: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type PlanottoHint = {
  id: string;
  title: string;
  text: string;
};

function getPageHint(pathname: string): PlanottoHint | null {
  if (pathname.startsWith("/menu")) {
    return {
      id: "menu",
      title: "Меню на период",
      text: "Здесь планируется питание по дням. Нажмите + в карточке приема пищи, чтобы добавить блюдо.",
    };
  }
  if (pathname.startsWith("/recipes")) {
    return {
      id: "recipes",
      title: "Рецепты",
      text: "Сохраняйте рецепты, добавляйте теги и ингредиенты. Потом они используются в меню и покупках.",
    };
  }
  if (pathname.startsWith("/pantry")) {
    return {
      id: "pantry",
      title: "Кладовка",
      text: "Тут хранится остаток продуктов. После готовки ингредиенты можно списывать из кладовки.",
    };
  }
  if (pathname.startsWith("/shopping-list")) {
    return {
      id: "shopping",
      title: "Покупки",
      text: "Список покупок собирается из меню. Отмечайте купленное, и продукты попадут в кладовку.",
    };
  }
  return null;
}

const getAssistantMessage = (pathname: string): string => {
  if (pathname.startsWith("/recipes/new") || pathname.startsWith("/recipes/")) {
    return "Привет! Я Отто. Помогу держать рецепт под контролем: порции, теги и фото — через кнопки ИИ.";
  }
  if (pathname.startsWith("/recipes")) {
    return "Привет! Я рядом: помогу выбрать рецепты по фильтрам и быстро найти нужное.";
  }
  if (pathname.startsWith("/menu")) {
    return "Я рядом. Могу предложить меню на выбранный период.";
  }
  if (pathname.startsWith("/shopping-list")) {
    return "Отмечайте покупки, а я помогу ничего не забыть и держать список под контролем.";
  }
  if (pathname.startsWith("/pantry")) {
    return "Кладовка под контролем: добавляйте запасы и следите, что заканчивается.";
  }
  return "Привет! Я Отто. Я рядом и помогу всё держать под контролем.";
};

const getPromptPlaceholder = (pathname: string): string => {
  if (pathname.startsWith("/menu")) {
    return "Например: составь меню на 10 дней без рыбы и с простыми ужинами";
  }
  if (pathname.startsWith("/recipes")) {
    return "Например: как лучше добавить теги и ингредиенты?";
  }
  if (pathname.startsWith("/shopping-list")) {
    return "Например: почему продукт попал в список покупок?";
  }
  if (pathname.startsWith("/pantry")) {
    return "Например: почему не списалось из кладовки?";
  }
  return "Например: с чего начать и как лучше настроить сервис?";
};

const isCookingPrompt = (prompt: string): boolean => {
  const text = prompt.toLowerCase().trim();
  if (!text) return false;
  return (
    text.includes("как приготовить") ||
    text.includes("как сделать") ||
    text.includes("как испечь") ||
    text.includes("как сварить") ||
    text.includes("как пожарить") ||
    text.includes("как запечь") ||
    text.includes("рецепт") ||
    text.includes("омлет") ||
    text.includes("яичниц") ||
    text.includes("суп") ||
    text.includes("пирож")
  );
};

const buildLocalCookingResponse = (prompt: string): string => {
  const text = prompt.toLowerCase();
  if (text.includes("пирожное картошка") || text.includes("картошка пирожное")) {
    return [
      "Пирожное «Картошка»:",
      "1. Измельчите 300 г печенья в крошку.",
      "2. Добавьте 3 ст. л. какао, 120 г сгущенки и 80 г мягкого сливочного масла.",
      "3. Перемешайте до плотной массы, при необходимости добавьте 1-2 ст. л. молока.",
      "4. Сформируйте 8-10 пирожных, обваляйте в какао.",
      "5. Охладите 30-40 минут.",
    ].join("\n");
  }
  if (text.includes("омлет")) {
    return "Омлет: 2-3 яйца + 2-3 ст. л. молока + соль, взбить, вылить на сковороду с маслом, готовить 4-6 минут под крышкой на слабом огне.";
  }
  if (text.includes("яичниц")) {
    return "Яичница: разогрейте сковороду, добавьте немного масла, вбейте яйца, посолите и готовьте 2-4 минуты на среднем огне.";
  }
  return "Напишите блюдо и продукты, которые есть дома, и я дам короткий пошаговый рецепт с пропорциями.";
};

const getLocalHelpResponse = (pathname: string, prompt: string): string => {
  if (isCookingPrompt(prompt)) {
    return buildLocalCookingResponse(prompt);
  }
  const text = prompt.toLowerCase();
  if (pathname.startsWith("/recipes")) {
    if (text.includes("публич") || text.includes("приват")) {
      return "Private виден только вам. Public виден другим. Перед публикацией проверьте источник и права.";
    }
    return "В рецептах начните с названия и ингредиентов, затем добавьте теги и способ приготовления. Я могу подсказать шаги по вашему вопросу.";
  }
  if (pathname.startsWith("/shopping-list")) {
    return "Список покупок собирается из меню. Отмечайте купленное, и позиции переходят в кладовку.";
  }
  if (pathname.startsWith("/pantry")) {
    return "В кладовке храните остатки. Следите за одинаковыми названиями и единицами, тогда списание работает корректно.";
  }
  return "Откройте раздел и задайте вопрос по текущему экрану. Я подскажу, что делать дальше.";
};

const getStartActionMessage = (pathname: string): string => {
  if (pathname.startsWith("/menu")) {
    return "Отлично, начнем с меню. Выберите период сверху, затем нажмите + в нужном приеме пищи.";
  }
  if (pathname.startsWith("/recipes")) {
    return "Отлично, начнем с рецептов. Нажмите «Добавить рецепт» и заполните название с ингредиентами.";
  }
  if (pathname.startsWith("/pantry")) {
    return "Отлично, начнем с кладовки. Нажмите «Добавить продукт» и сохраните первую позицию.";
  }
  if (pathname.startsWith("/shopping-list")) {
    return "Отлично, начнем с покупок. Отмечайте купленное, и позиции перейдут в кладовку.";
  }
  return "Отлично! Откройте раздел «Меню» или «Рецепты», и я подскажу первый шаг.";
};

const isMenuGenerationPrompt = (prompt: string): boolean => {
  const text = prompt.toLowerCase().trim();
  if (!text) return false;

  const generationHints = [
    "составь меню",
    "сгенерируй меню",
    "сделай меню",
    "распиши меню",
    "подбери меню",
    "план питания",
    "меню на",
  ];

  return generationHints.some((hint) => text.includes(hint));
};

const canUseVoiceRecognition = (): boolean => {
  if (typeof window === "undefined") return false;
  if (window.isSecureContext) return true;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
};

const isLikelyInAppBrowser = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Instagram|FBAN|FBAV|Line|MiuiBrowser|YaApp_Android|wv|Telegram/i.test(ua);
};

const getVoiceRecognitionErrorText = (errorCode: string): string => {
  const code = errorCode.trim().toLowerCase();
  if (code === "not-allowed" || code === "service-not-allowed") {
    return "Нет доступа к микрофону. Разрешите микрофон в настройках браузера и обновите страницу.";
  }
  if (code === "audio-capture") {
    return "Микрофон не найден. Проверьте подключение и права доступа.";
  }
  if (code === "network") {
    return "Проблема сети при распознавании речи. Проверьте интернет и попробуйте снова.";
  }
  if (code === "no-speech") {
    return "Не услышал речь. Говорите чуть громче и поднесите телефон ближе.";
  }
  if (code === "language-not-supported") {
    return "Этот браузер не поддерживает выбранный язык распознавания.";
  }
  if (code === "aborted") {
    return "Распознавание остановлено. Попробуйте еще раз.";
  }
  return "Не удалось распознать голос. Попробуйте еще раз.";
};

export default function HouseAssistant() {
  const pathname = usePathname();
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const shouldPreferCollapsed =
    isMobileViewport ||
    pathname === "/" ||
    pathname.startsWith("/recipes/new") ||
    (pathname.startsWith("/recipes/") && pathname !== "/recipes");
  const [collapsed, setCollapsed] = useState(() => shouldPreferCollapsed);
  const [avatarSrc, setAvatarSrc] = useState<string>(() => loadAssistantAvatarSetting());
  const [menuAiMessage, setMenuAiMessage] = useState("");
  const [menuAiLoading, setMenuAiLoading] = useState(false);
  const [menuPrompt, setMenuPrompt] = useState("");
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [feedbackType, setFeedbackType] = useState<"recipes_missing" | "not_working" | "idea">("recipes_missing");
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState("");
  const [homeQuickAskMode, setHomeQuickAskMode] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(false);
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState("");
  const [hintsDisabled, setHintsDisabled] = useState(false);
  const [welcomeSeen, setWelcomeSeen] = useState(true);
  const [seenPageHints, setSeenPageHints] = useState<Record<string, boolean>>({});
  const [hintsHydrated, setHintsHydrated] = useState(false);
  const pendingVoiceReplyRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceResultReceivedRef = useRef(false);
  const voiceErrorHandledRef = useRef(false);
  const menuRequestTimeoutRef = useRef<number | null>(null);
  const menuStatusReceivedRef = useRef(false);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isMenuPage = pathname.startsWith("/menu");
  const pageHint = useMemo(() => getPageHint(pathname), [pathname]);
  const speechRecognitionCtor = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const typedWindow = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return typedWindow.SpeechRecognition || typedWindow.webkitSpeechRecognition;
  }, []);
  const voiceSupported = Boolean(speechRecognitionCtor);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 768px)");
    const syncViewport = () => setIsMobileViewport(media.matches);
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    try {
      const disabledRaw = localStorage.getItem(PLANOTTO_HINTS_DISABLED_KEY);
      const disabled = disabledRaw === "1";
      setHintsDisabled(disabled);

      const welcomeRaw = localStorage.getItem(PLANOTTO_WELCOME_SEEN_KEY);
      setWelcomeSeen(disabled || welcomeRaw === "1");

      const pageHintsRaw = localStorage.getItem(PLANOTTO_PAGE_HINTS_KEY);
      const parsed = pageHintsRaw ? JSON.parse(pageHintsRaw) : {};
      setSeenPageHints(parsed && typeof parsed === "object" ? parsed : {});
    } catch {
      setHintsDisabled(false);
      setWelcomeSeen(false);
      setSeenPageHints({});
    } finally {
      setHintsHydrated(true);
    }
  }, []);

  useEffect(() => {
    const clearMenuTimeout = () => {
      if (menuRequestTimeoutRef.current !== null) {
        window.clearTimeout(menuRequestTimeoutRef.current);
        menuRequestTimeoutRef.current = null;
      }
    };

    const onChanged = () => {
      setAvatarSrc(loadAssistantAvatarSetting());
    };
    const onMenuAiStatus = (event: Event) => {
      menuStatusReceivedRef.current = true;
      const detail = (event as CustomEvent<{ isLoading?: boolean; message?: string }>).detail;
      setMenuAiLoading(Boolean(detail?.isLoading));
      if (typeof detail?.message === "string") {
        setMenuAiMessage(detail.message);
      }
      if (detail?.isLoading) {
        clearMenuTimeout();
        menuRequestTimeoutRef.current = window.setTimeout(() => {
          setMenuAiLoading(false);
          setMenuAiMessage(
            "Ответ задерживается. Попробуйте еще раз или переформулируйте вопрос короче."
          );
          menuRequestTimeoutRef.current = null;
        }, 15000);
      } else {
        clearMenuTimeout();
      }
    };

    const onMobileMenuToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      if (!detail?.open) return;
      setCollapsed(true);
      setShowFeedbackForm(false);
    };

    window.addEventListener("storage", onChanged);
    window.addEventListener(getAssistantAvatarChangedEventName(), onChanged as EventListener);
    window.addEventListener(MENU_AI_STATUS_EVENT, onMenuAiStatus as EventListener);
    window.addEventListener(MOBILE_MENU_TOGGLE_EVENT, onMobileMenuToggle as EventListener);
    return () => {
      clearMenuTimeout();
      window.removeEventListener("storage", onChanged);
      window.removeEventListener(getAssistantAvatarChangedEventName(), onChanged as EventListener);
      window.removeEventListener(MENU_AI_STATUS_EVENT, onMenuAiStatus as EventListener);
      window.removeEventListener(MOBILE_MENU_TOGGLE_EVENT, onMobileMenuToggle as EventListener);
    };
  }, []);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop?.();
        recognitionRef.current?.abort?.();
      } catch {
        // ignore cleanup errors
      } finally {
        recognitionRef.current = null;
      }
    };
  }, []);

  const message = useMemo(() => getAssistantMessage(pathname), [pathname]);
  const promptPlaceholder = useMemo(() => getPromptPlaceholder(pathname), [pathname]);
  const requestMenuSuggestionDirect = async (prompt: string) => {
    try {
      const data = await getMenuSuggestion({
        peopleCount: 2,
        days: 7,
        constraints: prompt,
        newDishPercent: 40,
        recipes: [],
      });
      setMenuAiMessage(data.message || "Подсказка готова.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось получить ответ от Отто.";
      setMenuAiMessage(text);
    } finally {
      setMenuAiLoading(false);
    }
  };

  const handleAskAssistant = async (promptOverride?: string, fromVoice = false) => {
    const prompt = (promptOverride ?? menuPrompt).trim();
    if (fromVoice) {
      pendingVoiceReplyRef.current = true;
    }
    if (!prompt) {
      setMenuAiMessage(getStartActionMessage(pathname));
      return;
    }
    setLastSubmittedPrompt(prompt);
    setMenuAiLoading(true);
    setMenuAiMessage("Вопрос отправлен. Жду ответ...");
    if (isMenuPage && isMenuGenerationPrompt(prompt)) {
      if (menuRequestTimeoutRef.current !== null) {
        window.clearTimeout(menuRequestTimeoutRef.current);
      }
      menuStatusReceivedRef.current = false;
      menuRequestTimeoutRef.current = window.setTimeout(() => {
        if (menuStatusReceivedRef.current) return;
        requestMenuSuggestionDirect(prompt);
        menuRequestTimeoutRef.current = null;
      }, 2500);
      window.dispatchEvent(
        new CustomEvent(MENU_AI_REQUEST_EVENT, {
          detail: { prompt },
        })
      );
      return;
    }

    try {
      const response = await getAssistantHelp({
        question: prompt,
        pathname,
      });
      const aiReply = String(response.message || "").trim();
      setMenuAiMessage(aiReply || getLocalHelpResponse(pathname, prompt));
    } catch {
      setMenuAiMessage(getLocalHelpResponse(pathname, prompt));
    } finally {
      setMenuAiLoading(false);
    }
  };

  const handleVoiceAsk = () => {
    if (!canUseVoiceRecognition()) {
      setMenuAiMessage("Голосовой ввод работает только в защищенном режиме (HTTPS или localhost).");
      return;
    }
    if (!voiceSupported) {
      if (isLikelyInAppBrowser()) {
        setMenuAiMessage(
          "Встроенный браузер ограничивает микрофон. Откройте сайт в Safari/Chrome и попробуйте снова."
        );
        return;
      }
      setMenuAiMessage("Голосовой ввод не поддерживается в этом браузере.");
      return;
    }
    if (voiceListening) return;
    if (!speechRecognitionCtor) {
      setMenuAiMessage("Голосовой ввод не поддерживается в этом браузере.");
      return;
    }

    try {
      recognitionRef.current?.stop?.();
      recognitionRef.current?.abort?.();
    } catch {
      // ignore restart errors
    }

    const recognition = new speechRecognitionCtor();
    recognitionRef.current = recognition;
    recognition.lang = "ru-RU";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;
    voiceResultReceivedRef.current = false;
    voiceErrorHandledRef.current = false;

    setVoiceListening(true);
    setMenuAiMessage("Слушаю вас...");

    recognition.onstart = () => {
      setMenuAiMessage("Слушаю вас...");
    };

    recognition.onresult = (event: SpeechRecognitionResultEventLike) => {
      voiceResultReceivedRef.current = true;
      const transcript = String(event?.results?.[0]?.[0]?.transcript || "").trim();
      if (!transcript) {
        setMenuAiMessage("Не удалось распознать фразу. Попробуйте еще раз.");
        pendingVoiceReplyRef.current = false;
        return;
      }
      setMenuPrompt(transcript);
      handleAskAssistant(transcript, true);
    };

    recognition.onnomatch = () => {
      voiceErrorHandledRef.current = true;
      setMenuAiMessage("Не удалось распознать фразу. Попробуйте еще раз.");
      pendingVoiceReplyRef.current = false;
      setVoiceListening(false);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      voiceErrorHandledRef.current = true;
      const code = String(event?.error || "");
      if ((code === "not-allowed" || code === "service-not-allowed") && isLikelyInAppBrowser()) {
        setMenuAiMessage("Браузер внутри мессенджера блокирует микрофон. Откройте сайт в Safari/Chrome.");
      } else {
        setMenuAiMessage(getVoiceRecognitionErrorText(code));
      }
      pendingVoiceReplyRef.current = false;
      setVoiceListening(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (!voiceResultReceivedRef.current && !voiceErrorHandledRef.current) {
        setMenuAiMessage("Не удалось распознать фразу. Попробуйте еще раз.");
        pendingVoiceReplyRef.current = false;
      }
      setVoiceListening(false);
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setVoiceListening(false);
      setMenuAiMessage("Не удалось запустить микрофон. Проверьте разрешение браузера.");
    }
  };

  useEffect(() => {
    if (!menuAiMessage) return;
    if (!pendingVoiceReplyRef.current) return;
    if (!voiceReplyEnabled) return;
    if (menuAiLoading) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    if (IGNORED_STATUS_MESSAGES.has(menuAiMessage.trim())) return;

    pendingVoiceReplyRef.current = false;
    const utterance = new SpeechSynthesisUtterance(menuAiMessage);
    utterance.lang = "ru-RU";
    utterance.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [menuAiLoading, menuAiMessage, voiceReplyEnabled]);

  const submitFeedback = () => {
    const text = feedbackText.trim();
    if (!text) {
      setFeedbackStatus("Опишите коротко проблему или идею.");
      return;
    }
    const key = "planottoFeedbackQueue";
    const payload = {
      id: crypto.randomUUID(),
      type: feedbackType,
      text,
      page: pathname,
      createdAt: new Date().toISOString(),
    };
    try {
      const raw = localStorage.getItem(key);
      const current = raw ? (JSON.parse(raw) as unknown[]) : [];
      const list = Array.isArray(current) ? current : [];
      localStorage.setItem(key, JSON.stringify([...list, payload]));
      setFeedbackText("");
      setFeedbackStatus("Спасибо! Передала сообщение команде.");
      setShowFeedbackForm(false);
    } catch {
      setFeedbackStatus("Не удалось отправить. Попробуйте еще раз.");
    }
  };

  const clearConversation = () => {
    setMenuPrompt("");
    setMenuAiMessage("");
    setLastSubmittedPrompt("");
    setFeedbackStatus("");
  };

  const startNewQuestion = () => {
    setMenuPrompt("");
    setLastSubmittedPrompt("");
    setMenuAiMessage("Чем еще помочь?");
    setTimeout(() => {
      promptTextareaRef.current?.focus();
    }, 0);
  };

  const finishConversation = () => {
    setMenuPrompt("");
    setLastSubmittedPrompt("");
    setMenuAiMessage("Разговор завершен. Если понадобится, я рядом.");
  };

  const markPageHintSeen = () => {
    if (!pageHint) return;
    const next = { ...seenPageHints, [pageHint.id]: true };
    setSeenPageHints(next);
    try {
      localStorage.setItem(PLANOTTO_PAGE_HINTS_KEY, JSON.stringify(next));
    } catch {
      // ignore storage errors
    }
  };

  const handleWelcomeStart = () => {
    setWelcomeSeen(true);
    const startMessage = getStartActionMessage(pathname);
    setMenuAiMessage(startMessage);
    if (pageHint) {
      const next = { ...seenPageHints };
      delete next[pageHint.id];
      setSeenPageHints(next);
      try {
        localStorage.setItem(PLANOTTO_PAGE_HINTS_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
    }
    try {
      localStorage.setItem(PLANOTTO_WELCOME_SEEN_KEY, "1");
    } catch {
      // ignore storage errors
    }
  };

  const disableHintsForever = () => {
    setHintsDisabled(true);
    setWelcomeSeen(true);
    try {
      localStorage.setItem(PLANOTTO_HINTS_DISABLED_KEY, "1");
      localStorage.setItem(PLANOTTO_WELCOME_SEEN_KEY, "1");
    } catch {
      // ignore storage errors
    }
  };

  const resetHints = () => {
    setHintsDisabled(false);
    setWelcomeSeen(false);
    setSeenPageHints({});
    try {
      localStorage.removeItem(PLANOTTO_HINTS_DISABLED_KEY);
      localStorage.removeItem(PLANOTTO_WELCOME_SEEN_KEY);
      localStorage.removeItem(PLANOTTO_PAGE_HINTS_KEY);
    } catch {
      // ignore storage errors
    }
  };

  const showWelcomeHint = hintsHydrated && !hintsDisabled && !welcomeSeen;
  const showPageHint =
    hintsHydrated && !hintsDisabled && welcomeSeen && Boolean(pageHint) && !seenPageHints[pageHint?.id || ""];
  const compactMobileAssistant = isMobileViewport;
  const isMobileHome = compactMobileAssistant && pathname === "/";
  const introMessage = compactMobileAssistant
    ? "Спросите про рецепт, меню или покупки."
    : message;
  const hasFinalAnswer =
    Boolean(menuAiMessage) &&
    !menuAiLoading &&
    !IGNORED_STATUS_MESSAGES.has(menuAiMessage.trim()) &&
    menuAiMessage.trim() !== "Разговор завершен. Если понадобится, я рядом.";

  useEffect(() => {
    if (shouldPreferCollapsed) {
      setCollapsed(true);
    }
  }, [shouldPreferCollapsed]);

  useEffect(() => {
    if (collapsed) {
      setHomeQuickAskMode(false);
      setShowFeedbackForm(false);
    }
  }, [collapsed]);

  useEffect(() => {
    if (pathname !== "/") {
      setHomeQuickAskMode(false);
    }
  }, [pathname]);

  if (collapsed) {
    return (
      <button
        className="house-assistant house-assistant--collapsed"
        onClick={() => setCollapsed(false)}
        aria-label="Открыть помощника"
        title="Открыть помощника"
      >
        <Image
          src={avatarSrc}
          alt="Отто помощник"
          className="house-assistant__avatar"
          width={56}
          height={56}
        />
        <span>Отто</span>
      </button>
    );
  }

  return (
    <>
      {isMobileViewport ? (
        <button
          type="button"
          className="house-assistant__backdrop"
          aria-label="Закрыть помощника"
          onClick={() => setCollapsed(true)}
        />
      ) : null}
      <aside className={`house-assistant ${shouldPreferCollapsed ? "house-assistant--subtle" : ""}`} aria-live="polite">
        <div className="house-assistant__header">
          <Image
            src={avatarSrc}
            alt="Отто помощник"
            className="house-assistant__avatar"
            width={56}
            height={56}
          />
          <div style={{ minWidth: 0 }}>
            <div className="house-assistant__title">Отто</div>
            {!compactMobileAssistant ? <div className="house-assistant__subtitle">Ваш помощник</div> : null}
          </div>
          <div className="house-assistant__header-actions">
            <button
              className="house-assistant__close"
              onClick={() => setCollapsed(true)}
              aria-label="Свернуть помощника"
              title="Свернуть"
            >
              ×
            </button>
          </div>
        </div>

        {isMobileHome && !homeQuickAskMode ? (
          <>
            <p className="house-assistant__text house-assistant__intro" style={{ marginTop: 2 }}>
              Я помогу начать. Нажмите Начать планирование или задайте вопрос.
            </p>
            <div className="house-assistant__home-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setHomeQuickAskMode(true);
                  setTimeout(() => promptTextareaRef.current?.focus(), 0);
                }}
              >
                Спросить Отто
              </button>
              <button className="btn" onClick={() => setCollapsed(true)}>
                Закрыть
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="house-assistant__text house-assistant__intro">{introMessage}</p>

            <div style={{ marginBottom: "10px" }}>
              <div className={`house-assistant__input-wrap${compactMobileAssistant ? " house-assistant__input-wrap--compact" : ""}`}>
                <textarea
                  ref={promptTextareaRef}
                  className="input"
                  value={menuPrompt}
                  onChange={(event) => setMenuPrompt(event.target.value)}
                  placeholder={promptPlaceholder}
                  rows={compactMobileAssistant ? 2 : 3}
                  style={{
                    minHeight: compactMobileAssistant ? "62px" : "74px",
                    resize: "vertical",
                    paddingRight: "42px",
                  }}
                />
                <button
                  className="house-assistant__voice-btn"
                  onClick={handleVoiceAsk}
                  disabled={voiceListening || menuAiLoading}
                  title="Спросить голосом"
                  aria-label="Спросить голосом"
                >
                  🎤
                </button>
              </div>
            </div>

            {menuAiMessage ? (
              <p className="house-assistant__text" style={{ marginTop: "0", whiteSpace: "pre-wrap" }}>
                {menuAiMessage}
              </p>
            ) : null}

            {menuAiLoading && lastSubmittedPrompt ? (
              <p className="house-assistant__text" style={{ marginTop: "0", color: "var(--text-secondary)" }}>
                Отправлено: {lastSubmittedPrompt}
              </p>
            ) : null}

            <div className="house-assistant__actions">
              <button className="btn btn-primary" onClick={() => handleAskAssistant()} disabled={menuAiLoading || voiceListening}>
                {menuAiLoading ? "Отто думает..." : "Спросить Отто"}
              </button>
            </div>
          </>
        )}

      </aside>
    </>
  );
}
