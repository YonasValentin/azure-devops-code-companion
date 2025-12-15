# Azure DevOps Code Companion

[![Version](https://img.shields.io/visual-studio-marketplace/v/YonasValentinMougaardKristensen.azure-devops-code-companion)](https://marketplace.visualstudio.com/items?itemName=YonasValentinMougaardKristensen.azure-devops-code-companion)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/YonasValentinMougaardKristensen.azure-devops-code-companion)](https://marketplace.visualstudio.com/items?itemName=YonasValentinMougaardKristensen.azure-devops-code-companion)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/YonasValentinMougaardKristensen.azure-devops-code-companion)](https://marketplace.visualstudio.com/items?itemName=YonasValentinMougaardKristensen.azure-devops-code-companion)
[![Sponsor](https://img.shields.io/github/sponsors/YonasValentin?label=Sponsor&logo=github)](https://github.com/sponsors/YonasValentin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Love this extension?** [Become a sponsor](https://github.com/sponsors/YonasValentin) to support ongoing development and new features.

---

## Stop Context Switching

Manage work items, track time, create branches, and submit pull requests without leaving VS Code.

---

## Features

### Work Items Sidebar
- View and manage work items with List/Kanban views
- Status overview badges with click-to-filter
- Quick status change on each work item
- Sprint selection and filtering

### Time Tracking
- Built-in timer with auto-pause on inactivity
- Auto-start timer when creating branches
- Auto-resume on activity detection
- Pomodoro timer (25-min work cycles)

### Git Integration
- Create branches with automatic work item linking
- Submit PRs with work item associations
- Customizable branch name templates
- Link work items to commits

### Pull Request Management
- Review and approve PRs directly from VS Code
- Complete/merge PRs with branch cleanup options
- View PR comments and linked work items

### Pipeline & Build Management
- Run pipelines with branch selection
- View build and pipeline logs
- Monitor pipeline runs with detailed status

### Additional Features
- Wiki integration
- Team capacity planning
- Work item templates
- Test plan browsing
- Real-time build status in status bar

---

## Quick Start

### 1. Setup Connection
```
1. Run command: "Azure DevOps: Setup Connection"
2. Enter your organization name
3. Enter your project name
4. Enter your Personal Access Token (PAT)
```

### 2. Create a Personal Access Token
1. Go to [Azure DevOps](https://dev.azure.com)
2. Click your profile picture → Security → Personal Access Tokens
3. Click "New Token" with these scopes:
   - Work Items (Read & Write)
   - Code (Read & Write)
   - Build (Read)
   - Pull Request (Read & Write)

### 3. Start Working
- Click the Azure DevOps icon in the Activity Bar
- Your work items appear in the sidebar
- Click any work item to start tracking time

---

## Commands

| Command | Description |
|---------|-------------|
| `Azure DevOps: Setup Connection` | Configure Azure DevOps connection |
| `Azure DevOps: Show Work Items` | Open work items sidebar |
| `Azure DevOps: Create Work Item` | Create new work item |
| `Azure DevOps: Start Timer` | Start time tracking |
| `Azure DevOps: Stop Timer` | Stop and save time entry |
| `Azure DevOps: Create Branch` | Create branch from work item |
| `Azure DevOps: Create Pull Request` | Create PR with work item link |
| `Azure DevOps: Toggle Kanban View` | Switch between List/Kanban |
| `Azure DevOps: Link Work Item to Commit` | Link commits to work items |
| `Azure DevOps: Insert Work Item Reference` | Insert AB#12345 at cursor |

---

## Keyboard Shortcuts

| Action | Mac | Windows/Linux |
|--------|-----|---------------|
| Refresh Work Items | `Cmd+Alt+R` | `Ctrl+Alt+R` |
| Create Work Item | `Cmd+Alt+N` | `Ctrl+Alt+N` |
| Start Timer | `Cmd+Alt+T` | `Ctrl+Alt+T` |
| Stop Timer | `Cmd+Alt+S` | `Ctrl+Alt+S` |
| Create Branch | `Cmd+Alt+B` | `Ctrl+Alt+B` |
| Create Pull Request | `Cmd+Alt+P` | `Ctrl+Alt+P` |
| Link Work Item to Commit | `Cmd+Alt+L` | `Ctrl+Alt+L` |

---

## Configuration

```json
{
  "azureDevOps.organization": "mycompany",
  "azureDevOps.project": "myproject",
  "azureDevOps.defaultWorkItemType": "Task",
  "azureDevOps.defaultQuery": "My Work Items",
  "azureDevOps.timerInactivityTimeout": 300,
  "azureDevOps.pomodoroEnabled": true,
  "azureDevOps.branchNameTemplate": "{type}/{id}-{title}",
  "azureDevOps.commitMessageTemplate": "AB#{id}: {message}"
}
```

---

## Requirements

- VS Code 1.102.0 or higher
- Azure DevOps account with project access
- Personal Access Token with required permissions

---

## Troubleshooting

<details>
<summary><strong>Connection Issues</strong></summary>

- Verify PAT has required permissions
- Check organization and project names are correct
- Ensure PAT hasn't expired
</details>

<details>
<summary><strong>Timer Not Working</strong></summary>

- Check if a work item is selected
- Verify timer commands in command palette
- Look for timer in status bar
</details>

<details>
<summary><strong>Work Items Not Loading</strong></summary>

- Check internet connection
- Verify Azure DevOps service status
- Try refreshing with toolbar button
</details>

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

## Contributing

Contributions are welcome! Here's how to get started:

### Development Setup

```bash
# Clone the repository
git clone https://github.com/YonasValentin/azure-devops-code-companion.git
cd azure-devops-code-companion

# Install dependencies
npm install

# Compile and watch for changes
npm run watch
```

### Running the Extension

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. The extension will be available in the new VS Code window

### Building for Production

```bash
# Type check, lint, and bundle
npm run compile

# Package for distribution
npm run package

# Create .vsix file
npx vsce package
```

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## Found a Bug?

[Open an issue on GitHub](https://github.com/YonasValentin/azure-devops-code-companion/issues)

---

## Support Development

This extension is free and open source. If it improves your Azure DevOps workflow, consider supporting its development:

### Sponsor on GitHub (Recommended)
GitHub Sponsors is the best way to support ongoing development. Sponsors get priority support and help fund new features.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/YonasValentin)

### Other ways to help
- [Leave a review](https://marketplace.visualstudio.com/items?itemName=YonasValentinMougaardKristensen.azure-devops-code-companion&ssr=false#review-details) on the VS Code Marketplace
- [Report issues](https://github.com/YonasValentin/azure-devops-code-companion/issues) to help improve quality
- [Buy me a coffee](https://www.buymeacoffee.com/YonasValentin) for one-time support

<a href="https://github.com/sponsors/YonasValentin">
  <img src="https://img.shields.io/badge/Sponsor_on_GitHub-30363D?style=for-the-badge&logo=github-sponsors&logoColor=EA4AAA" alt="Sponsor on GitHub" />
</a>
<a href="https://www.buymeacoffee.com/YonasValentin">
  <img src="https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee" />
</a>

---

MIT License
