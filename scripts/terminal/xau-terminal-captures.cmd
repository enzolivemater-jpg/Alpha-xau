@echo off
rem XAU V2 - terminal OFFLINE sur les captures locales (~/.local/share/xau-v2/evidence). HOLD, execution interdite.
rem Garder ce fichier a cote de xau-terminal.cmd ; double-cliquer pour lancer.
call "%~dp0xau-terminal.cmd" --captures-local %*
