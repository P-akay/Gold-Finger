@echo off
REM Lance le robot sur ce PC puis ouvre la page. Il faut Python (python.org, cocher "Add python to PATH").
cd /d "%~dp0"
python -m pip install --quiet "anthropic>=2.10,<3"
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8010"
python serveur.py
pause
