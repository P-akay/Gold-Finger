# Image pour héberger le robot (Hugging Face Spaces, Render, Koyeb…). Aucune clé n'est incluse :
# chaque visiteur met la sienne dans Réglages (gardée dans son navigateur).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY serveur.py comptes.py index.html app.js moteur.js marches.js ia.js analyse.js ./
ENV PORT=7860
EXPOSE 7860
CMD ["python", "serveur.py"]
