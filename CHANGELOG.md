# Change Log

All notable changes to the "Azure DevOps Code Companion" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.3.1] - 2025-01-23

### Fixed
- **Critical Connection Bug Fixes**
  - Fixed URL encoding issues for organization and project names with spaces and special characters
  - Resolved 500 server errors caused by malformed URLs
  - Added proper `encodeURIComponent()` handling for all Azure DevOps API calls
  - Fixed inconsistent URL construction patterns across the extension

- **Enhanced Error Handling & Debugging**
  - Comprehensive error messages with specific troubleshooting steps
  - Detailed logging for connection issues to help with debugging
  - Better handling of 400/404/500 server errors with contextual guidance
  - Added request/response logging for failed API calls

- **Improved Setup Experience**
  - Added input validation for organization and project names
  - Real-time validation during setup process
  - Detection of common user errors (pasting URLs instead of names)
  - PAT format validation with helpful error messages
  - Added timeout handling (30 seconds) for API calls

- **Production Readiness Improvements**
  - Better status code handling (don't throw on 4xx errors)
  - Consistent browser URL construction for external links
  - Enhanced validation to prevent setup errors
  - Improved user guidance for troubleshooting connection issues

## [1.3.0] - 2024-01-23

### Added
- **Enhanced Branch Creation**
  - Branch type selection (feature, bugfix, hotfix, chore, docs, release)
  - Smart default selection based on work item type
  - Improved branch naming with AB# prefix for better linking

- **Performance Improvements**
  - Implemented caching layer for API responses (5-15 minute TTL)
  - Reduced redundant API calls significantly
  - Faster work item loading and refresh

### Fixed
- **Memory Leak Fixes**
  - Fixed all timer-related memory leaks
  - Proper cleanup of intervals and timeouts on deactivation
  - Added dispose method to webview provider
  - Clear all resources when extension is deactivated

- **Improved Error Handling**
  - Centralized error handling with context-aware messages
  - Better authentication failure handling
  - Graceful degradation on API errors
  - User-friendly error messages with actionable recovery options

### Improved
- Better resource management throughout the extension
- More robust timer state management
- Cleaner codebase with error handling utilities
- Performance optimizations for large work item lists

## [1.2.2] - 2024-01-23

### Changed
- **Compact UI Design**
  - Significantly reduced padding and spacing throughout the sidebar
  - Made work item cards more slim and compact (6px padding)
  - Reduced all font sizes for a cleaner, more condensed view
  - Tightened margins and gaps between UI elements
  
- **Professional Icon Updates**
  - Replaced all emoji icons with VS Code codicons for consistency
  - Work item types now use appropriate codicons (checklist, bug, book, etc.)
  - Timer uses clock codicon instead of emoji
  - Header uses notebook codicon for cleaner appearance
  
- **Enhanced "In Review" Filter**
  - Added "Exclude In Review" checkbox to filter options
  - Filter properly excludes work items in "In Review" state
  - State persists with other filter preferences

### Improved
- Better visual hierarchy with reduced element sizes
- More professional appearance aligned with VS Code design
- Increased information density without sacrificing usability
- Maintained all functionality while improving space efficiency

## [1.2.1] - 2024-01-23

### Fixed
- **Timer Controls in Sidebar**
  - Fixed pause/stop timer buttons not working in the sidebar
  - Added proper resume functionality with dynamic button text
  - Timer state now properly updates in the sidebar
  
- **Active Work Item Highlighting**
  - Work items with active timer are now visually highlighted
  - Added "Active" indicator badge to timer work items
  - Active state persists across sidebar refreshes
  
- **Improved Filter UI**
  - Replaced state exclusion dropdown with checkboxes
  - Added checkbox filters for "Exclude Done", "Exclude Closed", and "Exclude Removed"
  - Better visual organization with dedicated checkbox section
  
- **Sidebar State Persistence**
  - Filter selections now persist when closing/reopening the sidebar
  - Sprint, type, and assignee filters are restored on reload
  - Checkbox states are properly saved and restored
  - Kanban/List view preference is remembered
  
- **Timer Display Improvements**
  - Timer container now properly shows/hides based on timer state
  - Timer updates immediately on pause/resume/stop actions
  - Pause button dynamically changes to Resume when timer is paused

### Improved
- Better separation of filter controls with dedicated rows
- More intuitive checkbox-based exclusion filters
- Enhanced visual feedback for active timer work items
- Smoother timer state transitions in the UI

## [1.2.0] - 2024-01-23

### Added
- **Enhanced Sidebar Functionality**
  - Status overview section with clickable badges showing work item distribution
  - Click on status badges to filter work items by that status
  - Quick status change button on each work item card for streamlined workflow
  - Visual indicators showing percentage of work items in each state
  
- **Improved Sprint Management**
  - Sprint selection dropdown in sidebar with current sprint highlighted
  - Filter work items by sprint directly from the sidebar
  - Support for "@CurrentIteration" filtering
  
- **Advanced State Filtering**
  - Exclude specific states (e.g., "Exclude Done", "Exclude Closed")
  - Quick filters for common state combinations
  - State-specific styling for better visual organization

- **Timer Enhancements**
  - Auto-start timer when creating branch from work item (configurable)
  - Auto-resume timer when activity detected after inactivity pause (configurable)
  - Visual timer state indicator with pause animation

### Improved
- Work item status updates now show contextual states based on work item type
- Status change dialog includes helpful descriptions and icons for each state
- More intuitive work item card layout with prominent status change button
- Better responsive design for status overview on smaller screens
- Enhanced CSS animations for improved user experience

## [1.1.0] - 2024-01-22

### Added
- **Comprehensive Pull Request Management**
  - View all pull requests (not just your own)
  - Filter by status (active, completed, abandoned)
  - Review and approve PRs directly from VS Code
  - Complete/merge PRs with delete source branch option
  - View PR comments, work items, and details
  - Add comments to pull requests

- **Advanced Pipeline & Build Management**
  - View and run pipelines with branch selection
  - Monitor pipeline runs with detailed status
  - View build and pipeline logs in VS Code
  - Quick access to build results and artifacts

- **Test Management Integration**
  - Browse test plans and test suites
  - View test cases with details
  - Navigate test hierarchy

- **Wiki Integration**
  - Browse wiki pages directly in VS Code
  - View wiki content in markdown preview
  - Create new wiki pages
  - Edit wiki pages in VS Code editor

- **Team Capacity & Planning**
  - View current sprint team capacity
  - See capacity vs remaining work
  - Team member availability and days off
  - Sprint burndown data
  - Capacity allocation percentage

- **Enhanced UI**
  - Quick action buttons for all major features
  - Improved navigation between different Azure DevOps areas
  - Better integration of all features in sidebar
  - Consistent command naming and organization

- **Work Item Templates & Quick Actions**
  - Create work items from predefined templates
  - Quick task and quick bug creation for rapid entry
  - Manage custom templates (create, edit, delete)
  - Default templates for common scenarios (code review, testing, documentation)
  - Template support for tags, priority, and assignment

- **Advanced Work Item Editing**
  - Edit work item fields directly from VS Code
  - Update title, description, tags, priority, iteration
  - Assign work items to team members
  - Edit effort/story points
  - Comprehensive field editing without leaving the IDE

### Improved
- Pull request commands now show more actions instead of just opening in browser
- Build status command now provides more options for interaction
- Better error handling for all new API calls
- More detailed output channels for logs and details
- Work item creation now offers templates and quick actions
- Enhanced work item management with in-place editing

## [1.0.3] - 2024-01-22

### Fixed
- Fixed webview buttons not working due to Content Security Policy restrictions
- Changed from inline onclick handlers to proper event delegation
- All buttons and interactive elements now use data attributes for security compliance
- Fixed work item card clicks and action buttons

## [1.0.2] - 2024-01-22

### Fixed
- Fixed URL encoding issue that was causing 404 errors
- Changed from encodeURIComponent to simple space replacement for project names
- Azure DevOps API doesn't accept fully encoded URLs, only space encoding is needed
- Added detailed debug logging to help diagnose connection issues
- Improved error messages for 404 errors to show organization and project names

## [1.0.1] - 2024-01-22

### Fixed
- Fixed 404 errors when organization or project names contain spaces or special characters
- All Azure DevOps API URLs now properly encode organization and project names
- Browser URLs for opening work items also properly encode special characters

## [1.0.0] - 2024-01-22

### Added
- **Work Items Management**
  - View and manage Azure DevOps work items directly in VS Code sidebar
  - Support for multiple queries: My Work Items, Current Sprint, All Active, Recently Updated
  - Create new work items (Task, Bug, User Story, Feature, Epic, Issue)
  - Update work item status and add comments
  - Advanced search and filtering capabilities
  - Kanban board view for visual task management
  - Copy work item ID to clipboard
  - Open work items in browser

- **Time Tracking**
  - Built-in timer with automatic pause detection (configurable inactivity timeout)
  - Pomodoro timer support (25-minute work sessions, 5-minute breaks)
  - Time entries automatically saved to work items
  - Comprehensive time reports (Today, This Week, This Month, All Time)
  - Timer persistence across VS Code sessions
  - Visual timer display in status bar

- **Git Integration**
  - Create branches from work items with smart naming (AB#12345-work-item-title)
  - Automatic work item ID extraction from branch names
  - One-click pull request creation with work item linking
  - View and manage your active pull requests

- **Build Monitoring**
  - Real-time build status in status bar
  - Build failure notifications
  - Quick access to build results

- **User Interface**
  - Modern, VS Code-themed interface
  - List and Kanban board views
  - Priority-based color coding
  - Responsive design with dark/light theme support
  - Beautiful sidebar with search and filters

- **Developer Experience**
  - Zero configuration required (works after setup)
  - Personal Access Token secure storage
  - Auto-refresh of work items
  - Welcome message for first-time users
  - Support and review prompts at milestones
  - Anonymous usage analytics (opt-out available)

### Security
- Secure storage of Personal Access Tokens using VS Code secrets API
- No credentials stored in plain text

### Known Issues
- Initial release - please report any issues on [GitHub](https://github.com/YonasValentin/azure-devops-code-companion/issues)

## [Unreleased]
- Bulk work item operations
- Custom fields support
- Burndown charts
- Export time reports to CSV/Excel
- Multiple organization support

---

**Enjoy using Azure DevOps Code Companion!**

If you find any bugs or have feature requests, please open an issue on [GitHub](https://github.com/YonasValentin/azure-devops-code-companion/issues).