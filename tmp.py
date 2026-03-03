import json, pathlib
text = pathlib.Path("app/lib/i18n/locales/ru.json").read_text("utf-8")
data = json.loads(text)
print(data["subscription"]["manage"]["statuses"])

