"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  getAssistantAvatarChangedEventName,
  loadAssistantAvatarSetting,
} from "../lib/assistantSettings";
import { getAssistantHelp, getMenuSuggestion } from "../lib/aiAssistantClient";

const MENU_AI_REQUEST_EVENT = "planotto:request-menu-ai";
const MENU_AI_STATUS_EVENT = "planotto:menu-ai-status";
const PLANOTTO_HINTS_DISABLED_KEY = "planottoHintsDisabled";
const PLANOTTO_WELCOME_SEEN_KEY = "planottoWelcomeSeen";
const PLANOTTO_PAGE_HINTS_KEY = "planottoPageHintsSeen";
const IGNORED_STATUS_MESSAGES = new Set(["Слушаю вас...", "Вопрос отправлен. Жду ответ..."]);

type SpeechRecognitionResultEventLike = {
  results?: ArrayLike<ArrayLike<{ transcript?: string }>>;
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
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

const getLocalHelpResponse = (pathname: string, prompt: string): string => {
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

export default function HouseAssistant() {
  const pathname = usePathname();
  const router = useRouter();
  const shouldPreferCollapsed =
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
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(false);
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState("");
  const [hintsDisabled, setHintsDisabled] = useState(false);
  const [welcomeSeen, setWelcomeSeen] = useState(true);
  const [seenPageHints, setSeenPageHints] = useState<Record<string, boolean>>({});
  const [hintsHydrated, setHintsHydrated] = useState(false);
  const pendingVoiceReplyRef = useRef(false);
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

    window.addEventListener("storage", onChanged);
    window.addEventListener(getAssistantAvatarChangedEventName(), onChanged as EventListener);
    window.addEventListener(MENU_AI_STATUS_EVENT, onMenuAiStatus as EventListener);
    return () => {
      clearMenuTimeout();
      window.removeEventListener("storage", onChanged);
      window.removeEventListener(getAssistantAvatarChangedEventName(), onChanged as EventListener);
      window.removeEventListener(MENU_AI_STATUS_EVENT, onMenuAiStatus as EventListener);
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
    if (isMenuPage) {
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
    if (!voiceSupported) {
      setMenuAiMessage("Голосовой ввод не поддерживается в этом браузере.");
      return;
    }
    if (voiceListening) return;
    if (!speechRecognitionCtor) {
      setMenuAiMessage("Голосовой ввод не поддерживается в этом браузере.");
      return;
    }

    const recognition = new speechRecognitionCtor();
    recognition.lang = "ru-RU";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    setVoiceListening(true);
    setMenuAiMessage("Слушаю вас...");

    recognition.onresult = (event: SpeechRecognitionResultEventLike) => {
      const transcript = String(event?.results?.[0]?.[0]?.transcript || "").trim();
      if (!transcript) {
        setMenuAiMessage("Не удалось распознать фразу. Попробуйте еще раз.");
        pendingVoiceReplyRef.current = false;
        return;
      }
      setMenuPrompt(transcript);
      handleAskAssistant(transcript, true);
    };

    recognition.onerror = () => {
      setMenuAiMessage("Не удалось распознать голос. Попробуйте еще раз.");
      pendingVoiceReplyRef.current = false;
      setVoiceListening(false);
    };

    recognition.onend = () => {
      setVoiceListening(false);
    };

    recognition.start();
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

  if (collapsed) {
    return (
      <button
        className="house-assistant house-assistant--collapsed"
        onClick={() => setCollapsed(false)}
        aria-label="Открыть помощника"
        title="Открыть помощника"
      >
        <img src={avatarSrc} alt="Отто помощник" className="house-assistant__avatar" />
        <span>Отто</span>
      </button>
    );
  }

  return (
    <aside className={`house-assistant ${shouldPreferCollapsed ? "house-assistant--subtle" : ""}`} aria-live="polite">
      <button
        className="house-assistant__close"
        onClick={() => setCollapsed(true)}
        aria-label="Свернуть помощника"
        title="Свернуть"
      >
        ×
      </button>
      <div className="house-assistant__header">
        <img src={avatarSrc} alt="Отто помощник" className="house-assistant__avatar" />
        <div>
          <div className="house-assistant__title">Отто</div>
          <div className="house-assistant__subtitle">Ваш помощник</div>
        </div>
      </div>
      <p className="house-assistant__text">{message}</p>
      {showWelcomeHint ? (
        <div className="house-assistant__hint">
          <div className="house-assistant__hint-title">Добро пожаловать</div>
          <p className="house-assistant__text" style={{ marginBottom: "8px" }}>
            Я Отто. Помогу планировать меню, вести покупки и кладовку. Без вашего подтверждения ничего не меняю.
          </p>
          <div className="house-assistant__hint-actions">
            <button className="btn btn-primary" onClick={handleWelcomeStart}>
              Начать
            </button>
            <button className="btn" onClick={handleWelcomeStart}>
              Пропустить
            </button>
            <button className="btn" onClick={disableHintsForever}>
              Не показывать больше
            </button>
          </div>
        </div>
      ) : null}
      {showPageHint && pageHint ? (
        <div className="house-assistant__hint">
          <div className="house-assistant__hint-title">{pageHint.title}</div>
          <p className="house-assistant__text" style={{ marginBottom: "8px" }}>
            {pageHint.text}
          </p>
          <div className="house-assistant__hint-actions">
            <button className="btn btn-primary" onClick={markPageHintSeen}>
              Понятно
            </button>
            <button className="btn" onClick={disableHintsForever}>
              Не показывать больше
            </button>
          </div>
        </div>
      ) : null}
      <div style={{ marginBottom: "10px" }}>
        <textarea
          ref={promptTextareaRef}
          className="input"
          value={menuPrompt}
          onChange={(event) => setMenuPrompt(event.target.value)}
          placeholder={promptPlaceholder}
          rows={3}
          style={{ minHeight: "74px", resize: "vertical" }}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", marginTop: "8px", fontSize: "13px" }}>
          <input
            type="checkbox"
            checked={voiceReplyEnabled}
            onChange={(event) => setVoiceReplyEnabled(event.target.checked)}
          />
          Озвучивать ответ
        </label>
      </div>
      {menuAiMessage ? (
        <p className="house-assistant__text" style={{ marginTop: "0", whiteSpace: "pre-wrap" }}>
          {menuAiMessage}
        </p>
      ) : null}
      {hasFinalAnswer ? (
        <div style={{ marginTop: "2px", marginBottom: "10px" }}>
          <p className="house-assistant__text" style={{ marginTop: "0", marginBottom: "8px" }}>
            Чем еще помочь?
          </p>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button className="btn" onClick={startNewQuestion}>
              Еще вопрос
            </button>
            <button className="btn" onClick={finishConversation}>
              Завершить разговор
            </button>
            <button className="btn" onClick={clearConversation}>
              Очистить
            </button>
          </div>
        </div>
      ) : null}
      {menuAiLoading && lastSubmittedPrompt ? (
        <p className="house-assistant__text" style={{ marginTop: "0", color: "var(--text-secondary)" }}>
          Отправлено: {lastSubmittedPrompt}
        </p>
      ) : null}
      {feedbackStatus ? (
        <p className="house-assistant__text" style={{ marginTop: "0", color: "var(--text-secondary)" }}>
          {feedbackStatus}
        </p>
      ) : null}
      {showFeedbackForm ? (
        <div style={{ marginBottom: "10px", display: "grid", gap: "8px" }}>
          <select
            className="input"
            value={feedbackType}
            onChange={(event) =>
              setFeedbackType(event.target.value as "recipes_missing" | "not_working" | "idea")
            }
          >
            <option value="recipes_missing">Я не вижу свои рецепты</option>
            <option value="not_working">Что-то работает не так</option>
            <option value="idea">Это идея</option>
          </select>
          <textarea
            className="input"
            value={feedbackText}
            onChange={(event) => setFeedbackText(event.target.value)}
            rows={3}
            placeholder="Коротко: что вы делали, что ожидали и что получилось"
            style={{ minHeight: "74px", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={submitFeedback}>
              Отправить
            </button>
            <button className="btn" onClick={() => setShowFeedbackForm(false)}>
              Отмена
            </button>
          </div>
        </div>
      ) : null}
      <div className="house-assistant__actions">
        <button className="btn" onClick={() => setCollapsed(true)}>
          Свернуть
        </button>
        <button className="btn" onClick={() => router.push("/recipes")}>
          К рецептам
        </button>
        <button className="btn" onClick={() => setShowFeedbackForm((prev) => !prev)}>
          Нужна помощь?
        </button>
        <button className="btn" onClick={resetHints}>
          Показать подсказки снова
        </button>
        <button className="btn btn-primary" onClick={() => handleAskAssistant()} disabled={menuAiLoading || voiceListening}>
          {menuAiLoading ? "Отто думает..." : "Спросить Отто"}
        </button>
        <button
          className="btn"
          onClick={handleVoiceAsk}
          disabled={voiceListening || menuAiLoading}
          title="Спросить голосом"
        >
          {voiceListening ? "Слушаю..." : "🎤 Спросить голосом"}
        </button>
        {!isMenuPage ? (
          <button className="btn" onClick={() => router.push("/menu")}>
            К меню
          </button>
        ) : null}
      </div>
    </aside>
  );
}
