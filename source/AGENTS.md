# time-and-projects-management — инструкция для ИИ-агентов

## Сервер .14 через GitHub
На сервере 139.60.162.14 (`falcon-server-1`) стоит self-hosted GitHub Actions runner этого репозитория:
- имя/метка: `falcon-14`
- пользователь `gh-runner` — **без sudo и без docker**
- каталог: `/opt/gh-runner/time-and-projects-management`; job стартует в `_work/time-and-projects-management/time-and-projects-management` (код репо там появится только с шагом `actions/checkout@v4`)

Любой workflow с `runs-on: [self-hosted, falcon-14]` выполняется на .14.

### Разовая команда
```bash
gh workflow run server.yml -f cmd="uname -a; df -h /"
gh run watch $(gh run list -w server.yml -L1 --json databaseId -q '.[0].databaseId')
gh run view --log $(gh run list -w server.yml -L1 --json databaseId -q '.[0].databaseId')
```
Если `gh` недоступен — тот же запуск через API: `POST /repos/doolbarez/time-and-projects-management/actions/workflows/server.yml/dispatches` с `{"ref":"main","inputs":{"cmd":"..."}}`.

### Свой workflow
Кладите в `.github/workflows/*.yml`, `runs-on: [self-hosted, falcon-14]`, `permissions: {}` (или минимально нужные).
Workflow с `workflow_dispatch` запускается только после попадания в ветку по умолчанию (`main`).

### Правила
- Сервер боевой: на нём крутятся чужие проекты (`/opt/*`, docker, nginx). Не трогайте их, не грузите CPU/диск надолго.
- Секреты — в GitHub Secrets репозитория, не в коде и не в логах.
- Нужны root/docker/nginx — это вне возможностей runner'а: попросите Юрия.
- Общие сервисы на .14 (без ключа, с localhost): Whisper `http://127.0.0.1:8840`, геокодер Photon `http://127.0.0.1:2322`.
