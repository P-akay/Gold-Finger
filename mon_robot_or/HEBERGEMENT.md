# Mettre Gold_finger en ligne gratuitement (et le partager)

Chacun utilise **sa propre clé** (Gemini gratuite, ou Claude payante) : il la colle dans ⚙️ Réglages, elle reste
dans son navigateur. Le site en ligne ne contient **aucune clé** → personne ne dépense ton argent.

## Option A — Hugging Face Spaces (gratuit, sans rien installer)

1. Crée un compte gratuit sur **huggingface.co** (bouton *Sign Up*).
2. En haut à droite : ton avatar → **New Space**.
   - *Space name* : `gold-finger` (ou ce que tu veux)
   - *SDK* : **Docker** → modèle **Blank**
   - *Hardware* : **CPU basic – free**
   - *Visibility* : **Public** (pour pouvoir donner le lien)
   - **Create Space**
3. Dans le Space : onglet **Files** → **Add file** → **Upload files**, et glisse ces fichiers du dossier `mon_robot_or` :
   `Dockerfile`, `README.md`, `requirements.txt`, `serveur.py`, `comptes.py`, `index.html`, `app.js`, `moteur.js`, `marches.js`, `ia.js`, `analyse.js`
   (⚠️ **jamais** `cle_gemini.txt` ni `cle_claude.txt`). Puis **Commit changes to main**.
4. Attends 2-3 minutes (onglet **App** : « Building » puis « Running »).
5. Ton lien : `https://TON-NOM-gold-finger.hf.space` → il s'ouvre sur PC, tablette, iPhone. Tu peux le donner à qui tu veux.

Bon à savoir :
- Gratuit, mais le Space **s'endort après ~48 h sans visite** ; la première visite suivante le réveille en ~1 minute.
- Pour mettre à jour : re-déposer les fichiers modifiés (Upload files), il se reconstruit tout seul.
- Les alertes marchent tant que la page est **ouverte** sur l'appareil (onglet ouvert, écran allumé sur iPhone).

## Comptes : un identifiant + un mot de passe par personne

Sans compte défini, le site est ouvert à quiconque a le lien. Pour exiger une connexion :

1. Sur ton PC, dans le dossier `mon_robot_or`, crée chaque compte (le mot de passe est demandé, rien ne s'affiche quand tu tapes, c'est normal) :
   ```
   python comptes.py ajouter ali
   ```
   Le script affiche **une ligne** du type `ali:pbkdf2$200000$…$…` (le mot de passe est chiffré, jamais écrit en clair).
2. Sur Hugging Face, dans ton Space : **Settings** → **Variables and secrets** → **New secret**
   - *Name* : `USERS`
   - *Value* : toutes les lignes, une par personne, séparées par un `;` (ex. `ali:pbkdf2$…;sara:pbkdf2$…`)
3. Ajoute un 2e secret : *Name* `SESSION_SECRET`, *Value* : une longue suite de lettres/chiffres au hasard (40 caractères ou plus).
   Il garde les gens connectés même quand le Space redémarre.
4. Le Space redémarre tout seul → le lien affiche maintenant une **page de connexion**.
   Chacun reste connecté 30 jours sur son appareil ; bouton **👤 Déconnexion** en haut.

Ajouter / retirer quelqu'un = modifier le secret `USERS` (le Space redémarre). Après 8 mauvais mots de passe,
l'adresse est bloquée 15 minutes. Les secrets ne sont **pas** visibles dans l'onglet Files (contrairement aux fichiers).

En local, tu peux faire pareil avec un fichier `utilisateurs.txt` (une ligne par compte) à côté de `serveur.py` — ne le dépose jamais sur Hugging Face.

## Option B — Donner une copie à quelqu'un (il le fait tourner sur son PC Windows)

1. Envoie-lui le dossier `mon_robot_or` en .zip **sans** `cle_gemini.txt` / `cle_claude.txt`.
2. Il installe Python (python.org, cocher **Add python to PATH**).
3. Il double-clique sur **`lancer.bat`** → la page s'ouvre sur `http://localhost:8010`.
4. Il colle sa propre clé dans ⚙️ Réglages.

## Où chacun trouve sa clé
- **Gemini (gratuite, ~20 requêtes/jour/modèle)** : aistudio.google.com → *Get API key*.
- **Claude (payante à l'usage, sans limite du jour)** : platform.claude.com → *Billing* (ajouter du crédit) → *API Keys*.
  L'abonnement claude.ai ne donne pas de clé API.
