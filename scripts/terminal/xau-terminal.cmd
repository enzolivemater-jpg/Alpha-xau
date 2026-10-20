@echo off
setlocal
rem XAU V2 - terminal OFFLINE local. HOLD, execution interdite. Double-cliquer pour lancer.
rem Les donnees locales (~/.local/share/xau-v2 : captures, fichiers CFTC declares) sont proposees dans la page.
rem Lance depuis le depot (\\wsl.localhost\<distribution>\... ou \\wsl$\<distribution>\...),
rem il deduit seul la distribution WSL et le dossier. Copie ailleurs (Bureau), il utilise ces valeurs :
set "XAU_DEFAULT_DISTRO=xau-agent"
set "XAU_DISTRO=%XAU_DEFAULT_DISTRO%"
set "XAU_DIR=/home/xauagent/projects/Alpha-xau/.claude/worktrees/xau-terminal"
set "REST="
set "XAU_HERE=%~dp0"
for /f "tokens=1,2,* delims=\" %%a in ("%XAU_HERE%") do (
  if /i "%%a"=="wsl$" (set "XAU_DISTRO=%%b" & set "REST=%%c")
  if /i "%%a"=="wsl.localhost" (set "XAU_DISTRO=%%b" & set "REST=%%c")
)
if defined REST (
  set "REST=%REST:\=/%"
)
if defined REST (
  set "XAU_DIR=/%REST:scripts/terminal/=%"
)
if "%XAU_DIR:~-1%"=="/" set "XAU_DIR=%XAU_DIR:~0,-1%"
title XAU V2 terminal OFFLINE - HOLD, execution interdite
echo Lanceur : %XAU_HERE%
rem Le nom lu dans le chemin UNC peut differer du nom WSL enregistre (casse) : le nom configure fait foi.
if /i "%XAU_DISTRO%"=="%XAU_DEFAULT_DISTRO%" set "XAU_DISTRO=%XAU_DEFAULT_DISTRO%"
rem Verifier la distribution avant de lancer : introuvable, le dire puis prendre la distribution configuree.
wsl.exe -d "%XAU_DISTRO%" -- true >nul 2>&1
if errorlevel 1 (
  echo Distribution "%XAU_DISTRO%" introuvable par wsl.exe : essai de "%XAU_DEFAULT_DISTRO%".
  set "XAU_DISTRO=%XAU_DEFAULT_DISTRO%"
)
echo Terminal XAU V2 OFFLINE - distribution %XAU_DISTRO%, dossier %XAU_DIR%
echo Fermer cette fenetre ou Ctrl+C pour arreter le terminal.
wsl.exe -d "%XAU_DISTRO%" --cd "%XAU_DIR%" -- sh scripts/terminal/xau-terminal.sh --local-data %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Echec du lancement, code %RC%.
  echo Verifier : WSL installe, distribution "%XAU_DISTRO%" presente, dossier "%XAU_DIR%" existant.
  echo Commande manuelle dans Ubuntu/WSL : cd %XAU_DIR% puis npm run terminal:local
  pause
)
endlocal
