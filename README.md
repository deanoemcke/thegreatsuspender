thegreatsuspender
=================

A Chrome extension for suspending all tabs to free up memory

Changelog 

v4.80   2013-10-01
- feature:  suspend multiple selected (highlighted) tabs


v4.77   2013-05-25
- bugfix:   switched off debug mode that was causing very quick suspending


v4.76   2013-05-25
- improv:   URLs starting with chrome-devtools: are never suspended
- bugfix:   activating a tab does not refresh its timeout
- bugfix:   'Suspend this tab' could potentially suspend more than one tab
- internal: added extra logging for easier debugging
- internal: some refactoring in background.js

v4.75   2013-05-20
- improv:   added option 'Don't suspend pinned tabs'

