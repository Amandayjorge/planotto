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
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

4. В Supabase Auth включите `Email + Password`.

## Stripe подписка (Pro)

Добавьте в `.env.local`:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_ID_PRO=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Что нужно настроить:

1. В Stripe создайте продукт/цену для Pro и укажите его в `STRIPE_PRICE_ID_PRO`.
2. В Stripe Webhooks добавьте endpoint:
   - `http://localhost:3000/api/billing/webhook` (локально через Stripe CLI/tunnel)
   - `https://your-domain.com/api/billing/webhook` (production)
3. События webhook:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Выполните SQL из `supabase/schema.sql` (там добавлены поля Stripe в `user_profiles`).

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
