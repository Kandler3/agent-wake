# Agent Wake — фоновые задачи и пробуждение чата Codex Desktop

[English](README.md) | **Русский**

[![Tests](https://github.com/Kandler3/agent-wake/actions/workflows/test.yml/badge.svg)](https://github.com/Kandler3/agent-wake/actions/workflows/test.yml)
[![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](package.json)
[![Windows / PowerShell](https://img.shields.io/badge/Windows-PowerShell-0078D4)](#требования)

**Agent Wake** (`agent-wake`) — локальный CLI-инструмент и скилл для Codex, который возвращает **тот же чат Codex Desktop** к работе после завершения фоновой команды, CI, бенчмарка или внешнего события.

Codex запускает разрешённую длительную задачу, возвращает вам управление и продолжает работу, когда получает результат. Ожиданием занимается фоновый процесс: агенту не нужно регулярно запускаться ради проверки статуса.

```text
Чат Codex → фоновая команда → событие завершения → продолжение в том же чате
```

Подходит для автоматизации Codex Desktop, ожидания GitHub Actions, запуска бенчмарков и асинхронной работы ИИ-агента.

## Возможности

- Запуск команд в фоне с сохранением кода завершения, stdout и stderr.
- Возврат результата в исходный чат при успехе, ошибке или таймауте.
- Передача текстовых и JSON-событий от локального процесса.
- Квитанции задач, просмотр состояния, отмена и контролируемая повторная доставка.
- Временный префикс ⏳ в названии чата, пока есть фоновые задачи.
- Установка обнаруживаемого скилла `agent-wake` для Codex.

Инструмент подключается к существующему общему App Server Codex по локальному WebSocket и передаёт `agent_wake.event_completed` как результат инструмента через `turn/start.toolOutput`. Это сторонняя интеграция; совместимость зависит от App Server в вашей установке.

## Требования

| Компонент | Требование |
| --- | --- |
| ОС | Windows: установщик и лаунчеры используют PowerShell |
| Среда | Node.js 22+ и PowerShell 7 (`pwsh`) |
| Codex Desktop | Существующий общий App Server с загруженным целевым чатом |
| Контекст | Переменная `CODEX_THREAD_ID`, унаследованная из этого чата |
| Протокол | Локальный WebSocket, `thread/loaded/list` и `turn/start.toolOutput` |
| Дополнительно | Git для клонирования; `gh`, Python и другие программы для ваших команд |

Для самого CLI не нужны npm-зависимости или отдельный API-ключ. Запускаемые команды и последующая работа Codex используют ваши существующие права и аккаунт.

**Обычной установки Desktop недостаточно, если в ней ещё нет нужного общего App Server.** Этот репозиторий не настраивает и не перезапускает Desktop, не создаёт сервер.

## Установка

### 1. Установите CLI и скилл

В PowerShell 7:

```powershell
git clone https://github.com/Kandler3/agent-wake.git
Set-Location agent-wake
.\install.ps1
```

Установщик копирует CLI в `~/.codex/agent-wake`, скилл — в `~/.codex/skills/agent-wake`, лаунчеры — в `~/.local/bin`. Если задан `CODEX_HOME`, CLI и скилл устанавливаются относительно него.

PATH и настройки App Server установщик не меняет. Если `~/.local/bin` отсутствует в PATH:

```powershell
& "$env:USERPROFILE\.local\bin\agent-wake.ps1" help
```

Для текущей сессии PowerShell можно добавить каталог:

```powershell
$env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"
```

### 2. Укажите существующий App Server

Создайте собственную конфигурацию Agent Wake из примера:

```powershell
$codexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$configPath = Join-Path $codexDirectory 'agent-wake\shared-desktop.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item .\examples\shared-desktop.example.json $configPath
}
```

Замените `port` в файле на порт **уже работающего общего App Server**, которым пользуется Desktop. `45000` в примере — заглушка; копирование файла не запускает сервер. Node берётся из PATH, если вы не указали абсолютный путь в поле `node`.

Конфигурация читается из файла, указанного в `AGENT_WAKE_CONFIG`, либо из `agent-wake/shared-desktop.json` внутри `CODEX_HOME` или `~/.codex`. Если выбранный файл отсутствует или некорректен, инструмент сообщает ошибку.

Подробности: [конфигурация и совместимость](docs/configuration.md).

### 3. Проверьте из нужного чата

Попросите Codex выполнить:

```powershell
agent-wake doctor
```

Команда должна запускаться из окружения целевого чата с его `CODEX_THREAD_ID`. При успехе ответ содержит `"ok":true` и `"current_thread_loaded":true`. В обычном терминале нужной переменной обычно нет.

При необходимости начните новый чат, чтобы Codex обнаружил скилл, и вызовите `$agent-wake`.

## Запуск фоновой команды

Заранее создайте UUID и сохраните его:

```powershell
$jobId = [guid]::NewGuid().ToString()
agent-wake run --name benchmark --job-id $jobId --timeout 4h -- python benchmark.py
```

`run` по умолчанию запускает фоновый процесс и сразу возвращает JSON-квитанцию с `job_id`. Codex может завершить текущий ход и продолжить работу после события.

Пример ожидания уже разрешённого запуска GitHub Actions:

```powershell
$jobId = [guid]::NewGuid().ToString()
agent-wake run --name ci --job-id $jobId --timeout 2h -- gh run watch 123456 --repo OWNER/REPO --exit-status
```

Подставьте ID запуска и репозиторий. Авторизация `gh`, требования песочницы и разрешения на команду действуют отдельно.

Команды запускаются напрямую. Для PowerShell-скрипта явно передайте интерпретатор:

```powershell
$jobId = [guid]::NewGuid().ToString()
agent-wake run --name ci --job-id $jobId --timeout 2h -- pwsh -NoProfile -File .\wait-ci.ps1
```

Для отдельной задачи нужен новый UUID. Если результат регистрации неизвестен, повторяйте исходный вызов с тем же UUID и аргументами, чтобы не запустить команду дважды.

## Передача внешнего события

Процесс-отправитель должен унаследовать `CODEX_THREAD_ID` нужного чата и конфигурацию. Например, процесс, запущенный Codex, может выполнить:

```powershell
$eventId = [guid]::NewGuid().ToString()
agent-wake emit --name build --event-id $eventId --text "Build finished"
```

Альтернатива для структурированного результата:

```powershell
$eventId = [guid]::NewGuid().ToString()
agent-wake emit --name benchmark --event-id $eventId --json-file .\result.json --detach
```

Для другого содержимого создайте новый ID события. Передаётся либо текст, либо JSON до 32 КиБ. Обычный `emit` делает одну попытку; `--detach` оставляет фоновый процесс для безопасных повторов доставки. CLI не предоставляет HTTP webhook.

## Управление задачами

```powershell
agent-wake status $jobId
agent-wake jobs
agent-wake cancel $jobId
agent-wake deliver $jobId
```

Задачи привязаны к текущему чату. Квитанции и логи хранятся в `~/.codex/agent-wake/jobs/UUID` или внутри `CODEX_HOME`. `deliver` повторяет только допустимую доставку готового события и не перезапускает исходную команду.

## Примеры запросов к Codex

> Используй $agent-wake: запусти бенчмарк в фоне и разбери результат после завершения.

> Дождись GitHub Actions run 123456 в OWNER/REPO и продолжи текущую задачу после CI.

> Запусти разрешённые тесты, верни мне управление и продолжи этот чат при успехе, ошибке или таймауте.

## Ограничения

Компьютер и общий App Server должны продолжать работать. Чат должен быть загружен при регистрации и доставке. Инструмент не загружает и не форкает чаты, не отвечает на запросы разрешений и не восстанавливает выполнявшуюся команду после перезагрузки ОС.

`accepted` подтверждает приём события сервером, а не завершение последующей работы агента. `delivery_unknown` и оставшийся `dispatching` означают неопределённую доставку: автоматическая повторная отправка останавливается. Сначала проверьте чат вместе с человеком.

Команды наследуют права, рабочий каталог и окружение вызывающего процесса. Логи и события — недоверенные данные инструмента. Они не дают новых разрешений.

## Проверки

```powershell
$env:AGENT_WAKE_TEST_ROOT = Join-Path (Get-Location) 'work\tests'
npm test
```

Тесты используют поддельный App Server и короткие локальные процессы, без отправки событий в реальные чаты. GitHub Actions запускает их на Windows с Node.js 22 и 24.

## Документация

- [Главный README на английском](README.md)
- [Конфигурация и диагностика](docs/configuration.md)
- [Состояния доставки, повторы, логи и отмена](docs/operations.md)
- [Инструкции скилла](skills/agent-wake/SKILL.md)
- [Протокол OpenAI App Server](https://learn.chatgpt.com/docs/app-server)

## Лицензия

[MIT](LICENSE) © 2026 Artem Kovalchuk.

Ключевые слова: agent wake, agent awake, пробуждение Codex, фоновые задачи Codex Desktop, скилл Codex, асинхронный агент, ожидание CI, завершение бенчмарка, уведомление о завершении команды.
