@echo off
setlocal
rem XAU V2 - terminal OFFLINE local - HOLD - execution interdite - double-cliquer pour lancer
rem Fonctionne depuis le depot ou depuis une copie - Bureau - avec les deux valeurs ci-dessous
rem Les donnees locales de ~/.local/share/xau-v2 sont proposees dans la page
set XAU_DISTRO=xau-agent
set XAU_DIR=/home/xauagent/projects/Alpha-xau/.claude/worktrees/xau-terminal
title XAU V2 terminal OFFLINE - HOLD - execution interdite
echo Terminal XAU V2 OFFLINE - distribution %XAU_DISTRO% - dossier %XAU_DIR%
echo Fermer cette fenetre ou Ctrl+C pour arreter le terminal.
wsl.exe -d %XAU_DISTRO% -- sh %XAU_DIR%/scripts/terminal/xau-terminal.sh --local-data %*
if not "%ERRORLEVEL%"=="0" pause
endlocal
