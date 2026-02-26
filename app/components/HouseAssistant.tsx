"use client";

import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { usePathname } from "next/navigation";
import Image from "next/image";
import {
  getAssistantAvatarChangedEventName,
  loadAssistantAvatarSetting,
} from "../lib/assistantSettings";
import { getAssistantHelp, getMenuSuggestion } from "../lib/aiAssistantClient";
import { useI18n } from "./I18nProvider";

const MENU_AI_REQUEST_EVENT = "planotto:request-menu-ai";
const MENU_AI_STATUS_EVENT = "planotto:menu-ai-status";
const MOBILE_MENU_TOGGLE_EVENT = "planotto:mobile-menu-toggle";
const PLANOTTO_HINTS_DISABLED_KEY = "planottoHintsDisabled";
const PLANOTTO_WELCOME_SEEN_KEY = "planottoWelcomeSeen";
const PLANOTTO_PAGE_HINTS_KEY = "planottoPageHintsSeen";
const normalizeAssistantLocale = (value: string): "ru" | "en" | "es" => {
  if (value === "en" || value === "es") return value;
  return "ru";
};

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

const ASSISTANT_TEXT = {
  ru: {
    name: "Отто",
    subtitle: "Ваш помощник",
    compactIntro: "Спросите про рецепт, меню или покупки.",
    homeIntro: "Я помогу начать. Нажмите Начать планирование или задайте вопрос.",
    openAssistant: "Открыть помощника",
    closeAssistant: "Закрыть помощника",
    collapseAssistant: "Свернуть помощника",
    close: "Закрыть",
    askOtto: "Спросить Отто",
    askVoice: "Спросить голосом",
    sentPrefix: "Отправлено:",
    ottoThinking: "Отто думает...",
    placeholderDefault: "Например: с чего начать и как лучше настроить сервис?",
    status: {
      listening: "Слушаю вас...",
      questionSent: "Вопрос отправлен. Жду ответ...",
      responseDelayed: "Ответ задерживается. Попробуйте еще раз или переформулируйте вопрос короче.",
      tipReady: "Подсказка готова.",
      aiFailed: "Не удалось получить ответ от Отто.",
      voiceSecureOnly: "Голосовой ввод работает только в защищенном режиме (HTTPS или localhost).",
      inAppBlocked:
        "Встроенный браузер ограничивает микрофон. Откройте сайт в Safari/Chrome и попробуйте снова.",
      voiceUnsupported: "Голосовой ввод не поддерживается в этом браузере.",
      speechNotRecognized: "Не удалось распознать фразу. Попробуйте еще раз.",
      browserBlocksMic: "Браузер внутри мессенджера блокирует микрофон. Откройте сайт в Safari/Chrome.",
      micStartFailed: "Не удалось запустить микрофон. Проверьте разрешение браузера.",
      feedbackPrompt: "Опишите коротко проблему или идею.",
      feedbackThanks: "Спасибо! Передала сообщение команде.",
      feedbackFailed: "Не удалось отправить. Попробуйте еще раз.",
      askMore: "Чем еще помочь?",
      conversationDone: "Разговор завершен. Если понадобится, я рядом.",
    },
    voiceErrors: {
      notAllowed: "Нет доступа к микрофону. Разрешите микрофон в настройках браузера и обновите страницу.",
      noMic: "Микрофон не найден. Проверьте подключение и права доступа.",
      network: "Проблема сети при распознавании речи. Проверьте интернет и попробуйте снова.",
      noSpeech: "Не услышал речь. Говорите чуть громче и поднесите телефон ближе.",
      langUnsupported: "Этот браузер не поддерживает выбранный язык распознавания.",
      aborted: "Распознавание остановлено. Попробуйте еще раз.",
      fallback: "Не удалось распознать голос. Попробуйте еще раз.",
    },
  },
  en: {
    name: "Otto",
    subtitle: "Your helper",
    compactIntro: "Ask about recipes, menu, or shopping.",
    homeIntro: "I can help you start. Tap Start planning or ask a question.",
    openAssistant: "Open assistant",
    closeAssistant: "Close assistant",
    collapseAssistant: "Collapse assistant",
    close: "Close",
    askOtto: "Ask Otto",
    askVoice: "Ask by voice",
    sentPrefix: "Sent:",
    ottoThinking: "Otto is thinking...",
    placeholderDefault: "For example: where should I start and how to set up the app?",
    status: {
      listening: "Listening...",
      questionSent: "Question sent. Waiting for reply...",
      responseDelayed: "Response is delayed. Try again or ask a shorter question.",
      tipReady: "Suggestion is ready.",
      aiFailed: "Failed to get a response from Otto.",
      voiceSecureOnly: "Voice input works only in secure mode (HTTPS or localhost).",
      inAppBlocked: "In-app browser limits microphone access. Open the site in Safari/Chrome and try again.",
      voiceUnsupported: "Voice input is not supported in this browser.",
      speechNotRecognized: "Could not recognize speech. Please try again.",
      browserBlocksMic: "Messenger in-app browser blocks microphone. Open the site in Safari/Chrome.",
      micStartFailed: "Could not start microphone. Check browser permissions.",
      feedbackPrompt: "Describe the issue or idea briefly.",
      feedbackThanks: "Thanks! Your feedback has been queued.",
      feedbackFailed: "Failed to send. Please try again.",
      askMore: "How else can I help?",
      conversationDone: "Conversation finished. I'm here if you need me.",
    },
    voiceErrors: {
      notAllowed: "No microphone access. Allow microphone in browser settings and refresh the page.",
      noMic: "Microphone not found. Check connection and permissions.",
      network: "Network problem during speech recognition. Check internet and try again.",
      noSpeech: "No speech detected. Speak a bit louder and keep phone closer.",
      langUnsupported: "This browser does not support selected recognition language.",
      aborted: "Speech recognition stopped. Try again.",
      fallback: "Could not recognize voice. Please try again.",
    },
  },
  es: {
    name: "Otto",
    subtitle: "Tu asistente",
    compactIntro: "Pregunta sobre recetas, menu o compras.",
    homeIntro: "Te ayudo a empezar. Pulsa Iniciar planificacion o haz una pregunta.",
    openAssistant: "Abrir asistente",
    closeAssistant: "Cerrar asistente",
    collapseAssistant: "Minimizar asistente",
    close: "Cerrar",
    askOtto: "Preguntar a Otto",
    askVoice: "Preguntar por voz",
    sentPrefix: "Enviado:",
    ottoThinking: "Otto esta pensando...",
    placeholderDefault: "Por ejemplo: por donde empezar y como configurar la app?",
    status: {
      listening: "Escuchando...",
      questionSent: "Pregunta enviada. Esperando respuesta...",
      responseDelayed: "La respuesta se demora. Intenta otra vez o pregunta mas corta.",
      tipReady: "Sugerencia lista.",
      aiFailed: "No se pudo obtener respuesta de Otto.",
      voiceSecureOnly: "La voz solo funciona en modo seguro (HTTPS o localhost).",
      inAppBlocked: "El navegador integrado limita el microfono. Abre el sitio en Safari/Chrome.",
      voiceUnsupported: "La voz no es compatible con este navegador.",
      speechNotRecognized: "No se reconocio la frase. Intenta otra vez.",
      browserBlocksMic: "El navegador del mensajero bloquea el microfono. Abre el sitio en Safari/Chrome.",
      micStartFailed: "No se pudo iniciar el microfono. Revisa permisos del navegador.",
      feedbackPrompt: "Describe brevemente el problema o idea.",
      feedbackThanks: "Gracias! Tu mensaje fue enviado al equipo.",
      feedbackFailed: "No se pudo enviar. Intenta otra vez.",
      askMore: "En que mas te ayudo?",
      conversationDone: "Conversacion terminada. Aqui estare si me necesitas.",
    },
    voiceErrors: {
      notAllowed: "Sin acceso al microfono. Activalo en el navegador y recarga la pagina.",
      noMic: "No se encontro microfono. Revisa conexion y permisos.",
      network: "Problema de red en reconocimiento de voz. Revisa internet e intenta de nuevo.",
      noSpeech: "No se detecto voz. Habla mas fuerte y acerca el telefono.",
      langUnsupported: "Este navegador no admite el idioma de reconocimiento.",
      aborted: "Reconocimiento detenido. Intenta de nuevo.",
      fallback: "No se pudo reconocer la voz. Intenta de nuevo.",
    },
  },
} as const;

type AssistantText = (typeof ASSISTANT_TEXT)[keyof typeof ASSISTANT_TEXT];

const getAssistantText = (locale: string): AssistantText => ASSISTANT_TEXT[normalizeAssistantLocale(locale)];

function getPageHint(pathname: string, locale: "ru" | "en" | "es"): PlanottoHint | null {
  if (pathname.startsWith("/menu")) {
    if (locale === "en") {
      return {
        id: "menu",
        title: "Menu for period",
        text: "Plan meals by day here. Press + on a meal card to add a dish.",
      };
    }
    if (locale === "es") {
      return {
        id: "menu",
        title: "Menu del periodo",
        text: "Aqui planificas comidas por dias. Pulsa + en la tarjeta de comida para anadir un plato.",
      };
    }
    return {
      id: "menu",
      title: "Меню на период",
      text: "Здесь планируется питание по дням. Нажмите + в карточке приема пищи, чтобы добавить блюдо.",
    };
  }
  if (pathname.startsWith("/recipes")) {
    if (locale === "en") {
      return {
        id: "recipes",
        title: "Recipes",
        text: "Save recipes, add tags and ingredients. Then use them in menu and shopping.",
      };
    }
    if (locale === "es") {
      return {
        id: "recipes",
        title: "Recetas",
        text: "Guarda recetas, anade etiquetas e ingredientes. Luego se usan en menu y compras.",
      };
    }
    return {
      id: "recipes",
      title: "Рецепты",
      text: "Сохраняйте рецепты, добавляйте теги и ингредиенты. Потом они используются в меню и покупках.",
    };
  }
  if (pathname.startsWith("/pantry")) {
    if (locale === "en") {
      return {
        id: "pantry",
        title: "Pantry",
        text: "Store leftovers here. After cooking, deduct ingredients from pantry.",
      };
    }
    if (locale === "es") {
      return {
        id: "pantry",
        title: "Despensa",
        text: "Aqui guardas existencias. Tras cocinar, puedes descontar ingredientes de la despensa.",
      };
    }
    return {
      id: "pantry",
      title: "Кладовка",
      text: "Тут хранится остаток продуктов. После готовки ингредиенты можно списывать из кладовки.",
    };
  }
  if (pathname.startsWith("/shopping-list")) {
    if (locale === "en") {
      return {
        id: "shopping",
        title: "Shopping",
        text: "Shopping list is built from menu. Mark purchased items to move them to pantry.",
      };
    }
    if (locale === "es") {
      return {
        id: "shopping",
        title: "Compras",
        text: "La lista se arma desde el menu. Marca lo comprado y los productos pasan a la despensa.",
      };
    }
    return {
      id: "shopping",
      title: "Покупки",
      text: "Список покупок собирается из меню. Отмечайте купленное, и продукты попадут в кладовку.",
    };
  }
  return null;
}

const getAssistantMessage = (pathname: string, locale: "ru" | "en" | "es"): string => {
  if (pathname.startsWith("/recipes/new") || pathname.startsWith("/recipes/")) {
    if (locale === "en") return "Hi! I'm Otto. I'll help keep your recipe in shape: servings, tags, and image via AI buttons.";
    if (locale === "es") return "Hola! Soy Otto. Te ayudo con la receta: porciones, etiquetas e imagen con botones de IA.";
    return "Привет! Я Отто. Помогу держать рецепт под контролем: порции, теги и фото — через кнопки ИИ.";
  }
  if (pathname.startsWith("/recipes")) {
    if (locale === "en") return "Hi! I can help choose recipes by filters and quickly find what you need.";
    if (locale === "es") return "Hola! Te ayudo a elegir recetas por filtros y encontrar lo necesario rapido.";
    return "Привет! Я рядом: помогу выбрать рецепты по фильтрам и быстро найти нужное.";
  }
  if (pathname.startsWith("/menu")) {
    if (locale === "en") return "I'm here. I can suggest a menu for the selected period.";
    if (locale === "es") return "Estoy aqui. Puedo sugerir un menu para el periodo elegido.";
    return "Я рядом. Могу предложить меню на выбранный период.";
  }
  if (pathname.startsWith("/shopping-list")) {
    if (locale === "en") return "Mark purchased items, and I'll help keep your list under control.";
    if (locale === "es") return "Marca compras y te ayudo a no olvidar nada y controlar la lista.";
    return "Отмечайте покупки, а я помогу ничего не забыть и держать список под контролем.";
  }
  if (pathname.startsWith("/pantry")) {
    if (locale === "en") return "Keep pantry in control: add stock and track what is running out.";
    if (locale === "es") return "Despensa bajo control: anade existencias y revisa que se acaba.";
    return "Кладовка под контролем: добавляйте запасы и следите, что заканчивается.";
  }
  if (locale === "en") return "Hi! I'm Otto. I'm here to help keep everything under control.";
  if (locale === "es") return "Hola! Soy Otto. Estoy aqui para ayudarte a tener todo bajo control.";
  return "Привет! Я Отто. Я рядом и помогу всё держать под контролем.";
};

const getPromptPlaceholder = (pathname: string, locale: "ru" | "en" | "es", fallback: string): string => {
  if (pathname.startsWith("/menu")) {
    if (locale === "en") return "For example: build a 10-day menu without fish and with simple dinners";
    if (locale === "es") return "Por ejemplo: crea menu de 10 dias sin pescado y con cenas simples";
    return "Например: составь меню на 10 дней без рыбы и с простыми ужинами";
  }
  if (pathname.startsWith("/recipes")) {
    if (locale === "en") return "For example: how to better add tags and ingredients?";
    if (locale === "es") return "Por ejemplo: como agregar mejor etiquetas e ingredientes?";
    return "Например: как лучше добавить теги и ингредиенты?";
  }
  if (pathname.startsWith("/shopping-list")) {
    if (locale === "en") return "For example: why did this product appear in shopping list?";
    if (locale === "es") return "Por ejemplo: por que este producto aparecio en la lista?";
    return "Например: почему продукт попал в список покупок?";
  }
  if (pathname.startsWith("/pantry")) {
    if (locale === "en") return "For example: why wasn't this deducted from pantry?";
    if (locale === "es") return "Por ejemplo: por que no se desconto de la despensa?";
    return "Например: почему не списалось из кладовки?";
  }
  return fallback;
};

const isCookingPrompt = (prompt: string): boolean => {
  const text = prompt.toLowerCase().trim();
  if (!text) return false;
  return (
    text.includes("как приготовить") ||
    text.includes("how to cook") ||
    text.includes("como cocinar") ||
    text.includes("как сделать") ||
    text.includes("how to make") ||
    text.includes("como hacer") ||
    text.includes("как испечь") ||
    text.includes("how to bake") ||
    text.includes("como hornear") ||
    text.includes("как сварить") ||
    text.includes("как пожарить") ||
    text.includes("как запечь") ||
    text.includes("рецепт") ||
    text.includes("recipe") ||
    text.includes("receta") ||
    text.includes("омлет") ||
    text.includes("omelet") ||
    text.includes("tortilla") ||
    text.includes("яичниц") ||
    text.includes("fried egg") ||
    text.includes("huevo") ||
    text.includes("суп") ||
    text.includes("soup") ||
    text.includes("sopa") ||
    text.includes("пирож")
  );
};

const isGeneralAssistantPrompt = (prompt: string): boolean => {
  const text = prompt.toLowerCase().trim();
  if (!text) return false;
  return (
    text.includes("how old are you") ||
    text.includes("who are you") ||
    text.includes("what are you") ||
    text.includes("сколько тебе лет") ||
    text.includes("кто ты") ||
    text.includes("что ты такое") ||
    text.includes("cuantos anos") ||
    text.includes("quien eres") ||
    text.includes("que eres")
  );
};

const buildLocalCookingResponse = (prompt: string, locale: "ru" | "en" | "es"): string => {
  const text = prompt.toLowerCase();
  if (text.includes("пирожное картошка") || text.includes("картошка пирожное")) {
    if (locale === "en") {
      return "Potato cake: crush cookies, add cocoa, condensed milk and butter, form cakes, roll in cocoa, chill for 30-40 minutes.";
    }
    if (locale === "es") {
      return "Pastelito Patata: tritura galletas, anade cacao, leche condensada y mantequilla, forma piezas, cubre con cacao y enfria 30-40 minutos.";
    }
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
    if (locale === "en") {
      return "Omelet: beat 2-3 eggs with 2-3 tbsp milk and salt, pour into oiled pan, cook 4-6 minutes on low heat under lid.";
    }
    if (locale === "es") {
      return "Tortilla: bate 2-3 huevos con 2-3 cdas de leche y sal, vierte en sarten con aceite y cocina 4-6 min a fuego bajo con tapa.";
    }
    return "Омлет: 2-3 яйца + 2-3 ст. л. молока + соль, взбить, вылить на сковороду с маслом, готовить 4-6 минут под крышкой на слабом огне.";
  }
  if (text.includes("яичниц")) {
    if (locale === "en") {
      return "Fried eggs: heat pan with a little oil, crack eggs, salt and cook 2-4 minutes over medium heat.";
    }
    if (locale === "es") {
      return "Huevos fritos: calienta la sarten con un poco de aceite, anade huevos, sal y cocina 2-4 min a fuego medio.";
    }
    return "Яичница: разогрейте сковороду, добавьте немного масла, вбейте яйца, посолите и готовьте 2-4 минуты на среднем огне.";
  }
  if (locale === "en") {
    return "Tell me the dish and available products, and I will give a short step-by-step recipe with proportions.";
  }
  if (locale === "es") {
    return "Escribe el plato y los productos que tienes, y te dare una receta corta paso a paso con proporciones.";
  }
  return "Напишите блюдо и продукты, которые есть дома, и я дам короткий пошаговый рецепт с пропорциями.";
};

const getLocalHelpResponse = (pathname: string, prompt: string, locale: "ru" | "en" | "es"): string => {
  if (isCookingPrompt(prompt)) {
    return buildLocalCookingResponse(prompt, locale);
  }
  if (isGeneralAssistantPrompt(prompt)) {
    if (locale === "en") {
      return "I'm Otto, a virtual helper in Planotto. I don't have an age, but I'm here to help with recipes, menu, pantry, and shopping.";
    }
    if (locale === "es") {
      return "Soy Otto, un asistente virtual de Planotto. No tengo edad, pero puedo ayudarte con recetas, menu, despensa y compras.";
    }
    return "Я Отто, виртуальный помощник Planotto. У меня нет возраста, но я помогаю с рецептами, меню, кладовкой и покупками.";
  }
  const text = prompt.toLowerCase();
  if (pathname.startsWith("/recipes")) {
    if (text.includes("публич") || text.includes("приват") || text.includes("public") || text.includes("private") || text.includes("publica") || text.includes("privada")) {
      if (locale === "en") {
        return "Private recipe is visible only to you. Public recipe is visible to others. Check source and rights before publishing.";
      }
      if (locale === "es") {
        return "La receta privada solo la ves tu. La publica la ven otros. Revisa fuente y derechos antes de publicar.";
      }
      return "Приватный рецепт виден только вам. Публичный виден другим. Перед публикацией проверьте источник и права.";
    }
    if (locale === "en") {
      return "In recipes, start with title and ingredients, then add tags and cooking steps. I can suggest next steps for your question.";
    }
    if (locale === "es") {
      return "En recetas, empieza con titulo e ingredientes, luego anade etiquetas y pasos. Te sugiero los siguientes pasos.";
    }
    return "В рецептах начните с названия и ингредиентов, затем добавьте теги и способ приготовления. Я могу подсказать шаги по вашему вопросу.";
  }
  if (pathname.startsWith("/shopping-list")) {
    if (locale === "en") return "Shopping list is built from menu. Mark purchased items, and they move to pantry.";
    if (locale === "es") return "La lista de compras se crea desde el menu. Marca comprado y pasa a la despensa.";
    return "Список покупок собирается из меню. Отмечайте купленное, и позиции переходят в кладовку.";
  }
  if (pathname.startsWith("/pantry")) {
    if (locale === "en") return "Store leftovers in pantry. Keep names and units consistent for correct deductions.";
    if (locale === "es") return "Guarda sobrantes en despensa. Mantener nombres y unidades iguales ayuda al descuento correcto.";
    return "В кладовке храните остатки. Следите за одинаковыми названиями и единицами, тогда списание работает корректно.";
  }
  if (locale === "en") return "Open a section and ask about the current screen. I'll tell you what to do next.";
  if (locale === "es") return "Abre una seccion y pregunta sobre esta pantalla. Te dire que hacer despues.";
  return "Откройте раздел и задайте вопрос по текущему экрану. Я подскажу, что делать дальше.";
};

const getStartActionMessage = (pathname: string, locale: "ru" | "en" | "es"): string => {
  if (pathname.startsWith("/menu")) {
    if (locale === "en") return "Great, let's start with menu. Choose period above, then press + in the needed meal slot.";
    if (locale === "es") return "Genial, empezamos con menu. Elige periodo arriba y pulsa + en la comida necesaria.";
    return "Отлично, начнем с меню. Выберите период сверху, затем нажмите + в нужном приеме пищи.";
  }
  if (pathname.startsWith("/recipes")) {
    if (locale === "en") return "Great, let's start with recipes. Press Add recipe and fill title with ingredients.";
    if (locale === "es") return "Genial, empezamos con recetas. Pulsa Anadir receta y completa titulo e ingredientes.";
    return "Отлично, начнем с рецептов. Нажмите «Добавить рецепт» и заполните название с ингредиентами.";
  }
  if (pathname.startsWith("/pantry")) {
    if (locale === "en") return "Great, let's start with pantry. Press Add product and save the first item.";
    if (locale === "es") return "Genial, empezamos con despensa. Pulsa Anadir producto y guarda el primer item.";
    return "Отлично, начнем с кладовки. Нажмите «Добавить продукт» и сохраните первую позицию.";
  }
  if (pathname.startsWith("/shopping-list")) {
    if (locale === "en") return "Great, let's start with shopping. Mark purchased items and they move to pantry.";
    if (locale === "es") return "Genial, empezamos con compras. Marca comprado y los items pasaran a despensa.";
    return "Отлично, начнем с покупок. Отмечайте купленное, и позиции перейдут в кладовку.";
  }
  if (locale === "en") return "Great! Open Menu or Recipes and I will suggest the first step.";
  if (locale === "es") return "Genial! Abre Menu o Recetas y te sugiero el primer paso.";
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
    "build menu",
    "generate menu",
    "make menu",
    "meal plan",
    "menu for",
    "crear menu",
    "generar menu",
    "plan de comidas",
    "menu para",
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

const getVoiceRecognitionErrorText = (errorCode: string, text: AssistantText): string => {
  const code = errorCode.trim().toLowerCase();
  if (code === "not-allowed" || code === "service-not-allowed") {
    return text.voiceErrors.notAllowed;
  }
  if (code === "audio-capture") {
    return text.voiceErrors.noMic;
  }
  if (code === "network") {
    return text.voiceErrors.network;
  }
  if (code === "no-speech") {
    return text.voiceErrors.noSpeech;
  }
  if (code === "language-not-supported") {
    return text.voiceErrors.langUnsupported;
  }
  if (code === "aborted") {
    return text.voiceErrors.aborted;
  }
  return text.voiceErrors.fallback;
};

const getRecognitionLang = (locale: "ru" | "en" | "es"): string => {
  if (locale === "en") return "en-US";
  if (locale === "es") return "es-ES";
  return "ru-RU";
};

export default function HouseAssistant() {
  const { locale } = useI18n();
  const uiLocale = normalizeAssistantLocale(locale);
  const assistantText = useMemo(() => getAssistantText(locale), [locale]);
  const ignoredStatusMessages = useMemo(
    () => new Set<string>([assistantText.status.listening, assistantText.status.questionSent]),
    [assistantText]
  );
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
  const [sheetDragOffset, setSheetDragOffset] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
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
  const sheetTouchStartYRef = useRef<number | null>(null);
  const isMenuPage = pathname.startsWith("/menu");
  const pageHint = useMemo(() => getPageHint(pathname, uiLocale), [pathname, uiLocale]);
  const speechRecognitionCtor = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const typedWindow = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return typedWindow.SpeechRecognition || typedWindow.webkitSpeechRecognition;
  }, []);
  const voiceSupported = Boolean(speechRecognitionCtor);

  const resetSheetDrag = () => {
    sheetTouchStartYRef.current = null;
    setSheetDragging(false);
    setSheetDragOffset(0);
  };

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
          setMenuAiMessage(assistantText.status.responseDelayed);
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
  }, [assistantText.status.responseDelayed]);

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

  const message = useMemo(() => getAssistantMessage(pathname, uiLocale), [pathname, uiLocale]);
  const promptPlaceholder = useMemo(
    () => getPromptPlaceholder(pathname, uiLocale, assistantText.placeholderDefault),
    [assistantText.placeholderDefault, pathname, uiLocale]
  );
  const requestMenuSuggestionDirect = async (prompt: string) => {
    try {
      const data = await getMenuSuggestion({
        peopleCount: 2,
        days: 7,
        constraints: prompt,
        newDishPercent: 40,
        recipes: [],
      });
      setMenuAiMessage(data.message || assistantText.status.tipReady);
    } catch (error) {
      const text = error instanceof Error ? error.message : assistantText.status.aiFailed;
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
      setMenuAiMessage(getStartActionMessage(pathname, uiLocale));
      return;
    }
    setLastSubmittedPrompt(prompt);
    setMenuAiLoading(true);
    setMenuAiMessage(assistantText.status.questionSent);
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
        locale: uiLocale,
      });
      const aiReply = String(response.message || "").trim();
      setMenuAiMessage(aiReply || getLocalHelpResponse(pathname, prompt, uiLocale));
    } catch {
      setMenuAiMessage(getLocalHelpResponse(pathname, prompt, uiLocale));
    } finally {
      setMenuAiLoading(false);
    }
  };

  const handleVoiceAsk = () => {
    if (!canUseVoiceRecognition()) {
      setMenuAiMessage(assistantText.status.voiceSecureOnly);
      return;
    }
    if (!voiceSupported) {
      if (isLikelyInAppBrowser()) {
        setMenuAiMessage(assistantText.status.inAppBlocked);
        return;
      }
      setMenuAiMessage(assistantText.status.voiceUnsupported);
      return;
    }
    if (voiceListening) return;
    if (!speechRecognitionCtor) {
      setMenuAiMessage(assistantText.status.voiceUnsupported);
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
    recognition.lang = getRecognitionLang(uiLocale);
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;
    voiceResultReceivedRef.current = false;
    voiceErrorHandledRef.current = false;

    setVoiceListening(true);
    setMenuAiMessage(assistantText.status.listening);

    recognition.onstart = () => {
      setMenuAiMessage(assistantText.status.listening);
    };

    recognition.onresult = (event: SpeechRecognitionResultEventLike) => {
      voiceResultReceivedRef.current = true;
      const transcript = String(event?.results?.[0]?.[0]?.transcript || "").trim();
      if (!transcript) {
        setMenuAiMessage(assistantText.status.speechNotRecognized);
        pendingVoiceReplyRef.current = false;
        return;
      }
      setMenuPrompt(transcript);
      handleAskAssistant(transcript, true);
    };

    recognition.onnomatch = () => {
      voiceErrorHandledRef.current = true;
      setMenuAiMessage(assistantText.status.speechNotRecognized);
      pendingVoiceReplyRef.current = false;
      setVoiceListening(false);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      voiceErrorHandledRef.current = true;
      const code = String(event?.error || "");
      if ((code === "not-allowed" || code === "service-not-allowed") && isLikelyInAppBrowser()) {
        setMenuAiMessage(assistantText.status.browserBlocksMic);
      } else {
        setMenuAiMessage(getVoiceRecognitionErrorText(code, assistantText));
      }
      pendingVoiceReplyRef.current = false;
      setVoiceListening(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (!voiceResultReceivedRef.current && !voiceErrorHandledRef.current) {
        setMenuAiMessage(assistantText.status.speechNotRecognized);
        pendingVoiceReplyRef.current = false;
      }
      setVoiceListening(false);
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setVoiceListening(false);
      setMenuAiMessage(assistantText.status.micStartFailed);
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

    if (ignoredStatusMessages.has(menuAiMessage.trim())) return;

    pendingVoiceReplyRef.current = false;
    const utterance = new SpeechSynthesisUtterance(menuAiMessage);
    utterance.lang = getRecognitionLang(uiLocale);
    utterance.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [ignoredStatusMessages, menuAiLoading, menuAiMessage, uiLocale, voiceReplyEnabled]);

  const submitFeedback = () => {
    const text = feedbackText.trim();
    if (!text) {
      setFeedbackStatus(assistantText.status.feedbackPrompt);
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
      setFeedbackStatus(assistantText.status.feedbackThanks);
      setShowFeedbackForm(false);
    } catch {
      setFeedbackStatus(assistantText.status.feedbackFailed);
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
    setMenuAiMessage(assistantText.status.askMore);
    setTimeout(() => {
      promptTextareaRef.current?.focus();
    }, 0);
  };

  const finishConversation = () => {
    setMenuPrompt("");
    setLastSubmittedPrompt("");
    setMenuAiMessage(assistantText.status.conversationDone);
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
    const startMessage = getStartActionMessage(pathname, uiLocale);
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
    ? assistantText.compactIntro
    : message;
  const hasFinalAnswer =
    Boolean(menuAiMessage) &&
    !menuAiLoading &&
    !ignoredStatusMessages.has(menuAiMessage.trim()) &&
    menuAiMessage.trim() !== assistantText.status.conversationDone;

  useEffect(() => {
    if (shouldPreferCollapsed) {
      setCollapsed(true);
    }
  }, [shouldPreferCollapsed]);

  useEffect(() => {
    if (collapsed) {
      setHomeQuickAskMode(false);
      setShowFeedbackForm(false);
      resetSheetDrag();
    }
  }, [collapsed]);

  useEffect(() => {
    if (pathname !== "/") {
      setHomeQuickAskMode(false);
    }
  }, [pathname]);

  useEffect(() => {
    if (!isMobileViewport) {
      resetSheetDrag();
    }
  }, [isMobileViewport]);

  const handleSheetTouchStart = (event: TouchEvent<HTMLElement>) => {
    if (!isMobileViewport) return;
    sheetTouchStartYRef.current = event.touches[0]?.clientY ?? null;
    setSheetDragging(true);
  };

  const handleSheetTouchMove = (event: TouchEvent<HTMLElement>) => {
    if (!isMobileViewport) return;
    const startY = sheetTouchStartYRef.current;
    if (startY === null) return;
    const currentY = event.touches[0]?.clientY ?? startY;
    const nextOffset = Math.max(0, currentY - startY);
    setSheetDragOffset(Math.min(nextOffset, 220));
    if (nextOffset > 0) {
      event.preventDefault();
    }
  };

  const handleSheetTouchEnd = () => {
    if (!isMobileViewport) return;
    const shouldClose = sheetDragOffset >= 90;
    resetSheetDrag();
    if (shouldClose) {
      setCollapsed(true);
    }
  };

  if (collapsed) {
    return (
      <button
        className="house-assistant house-assistant--collapsed"
        onClick={() => setCollapsed(false)}
        aria-label={assistantText.openAssistant}
        title={assistantText.openAssistant}
      >
        <Image
          src={avatarSrc}
          alt={assistantText.name}
          className="house-assistant__avatar"
          width={56}
          height={56}
        />
        <span>{assistantText.name}</span>
      </button>
    );
  }

  return (
    <>
      {isMobileViewport ? (
        <button
          type="button"
          className="house-assistant__backdrop"
          aria-label={assistantText.closeAssistant}
          onClick={() => setCollapsed(true)}
        />
      ) : null}
      <aside
        className={`house-assistant ${shouldPreferCollapsed ? "house-assistant--subtle" : ""} ${isMobileViewport ? "house-assistant--mobile-sheet" : ""} ${sheetDragging ? "house-assistant--dragging" : ""}`}
        aria-live="polite"
        style={
          isMobileViewport
            ? {
                transform: `translateY(${sheetDragOffset}px)`,
                transition: sheetDragging ? "none" : "transform 0.2s ease",
              }
            : undefined
        }
      >
        {isMobileViewport ? (
          <div
            className="house-assistant__drag-handle"
            onTouchStart={handleSheetTouchStart}
            onTouchMove={handleSheetTouchMove}
            onTouchEnd={handleSheetTouchEnd}
            onTouchCancel={handleSheetTouchEnd}
            aria-hidden="true"
          />
        ) : null}
        <div className="house-assistant__header">
          <Image
            src={avatarSrc}
            alt={assistantText.name}
            className="house-assistant__avatar"
            width={56}
            height={56}
          />
          <div style={{ minWidth: 0 }}>
            <div className="house-assistant__title">{assistantText.name}</div>
            {!compactMobileAssistant ? <div className="house-assistant__subtitle">{assistantText.subtitle}</div> : null}
          </div>
          <div className="house-assistant__header-actions">
            <button
              className="house-assistant__close"
              onClick={() => setCollapsed(true)}
              aria-label={assistantText.collapseAssistant}
              title={assistantText.collapseAssistant}
            >
              ×
            </button>
          </div>
        </div>

        {isMobileHome && !homeQuickAskMode ? (
          <>
            <p className="house-assistant__text house-assistant__intro" style={{ marginTop: 2 }}>
              {assistantText.homeIntro}
            </p>
            <div className="house-assistant__home-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setHomeQuickAskMode(true);
                  setTimeout(() => promptTextareaRef.current?.focus(), 0);
                }}
              >
                {assistantText.askOtto}
              </button>
              <button className="btn" onClick={() => setCollapsed(true)}>
                {assistantText.close}
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
                  title={assistantText.askVoice}
                  aria-label={assistantText.askVoice}
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
                {assistantText.sentPrefix} {lastSubmittedPrompt}
              </p>
            ) : null}

            <div className="house-assistant__actions">
              <button className="btn btn-primary" onClick={() => handleAskAssistant()} disabled={menuAiLoading || voiceListening}>
                {menuAiLoading ? assistantText.ottoThinking : assistantText.askOtto}
              </button>
            </div>
          </>
        )}

      </aside>
    </>
  );
}
