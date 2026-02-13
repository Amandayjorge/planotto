# Meal Planner (Planotto)

## Локальный запуск

```bash
npm install
npm run dev
```

Откройте `http://localhost:3000`.

## Supabase Setup

1. Создайте проект в Supabase.
2. Выполните SQL из файла `supabase/schema.sql`.
3. Добавьте в `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

4. В Supabase Auth включите `Email + Password`.

## Что уже подключено

- Страница авторизации: `app/auth/page.tsx`
- Список рецептов:
  - режимы `Мои / Публичные`
  - копирование публичного рецепта в свои
- Детальная страница рецепта:
  - редактирование только владельцем
  - переключатель `Private / Public`
- Импорт рецептов из старого `localStorage` при первом входе
- Приватные заметки вынесены в отдельную таблицу `recipe_notes`

## Сборка / деплой

```bash
npm run build
npm start
```

Проект готов к деплою на Vercel.
