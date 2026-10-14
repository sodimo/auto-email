/**
 * Dependency-free French admin UI. Cloudflare Access protects the custom
 * domain before the request reaches the Worker; machine endpoints may also
 * use the trigger token on workers.dev.
 */

export function adminPage(nonce: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Envois automatiques — Sodimo</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light;
      --bg: #f5f5f4;
      --surface: #ffffff;
      --surface-alt: #fafaf9;
      --border: #e7e5e4;
      --border-strong: #d6d3d1;
      --text: #292524;
      --muted: #78716c;
      --quiet: #a8a29e;
      --positive: #166534;
      --positive-bg: #f0fdf4;
      --warning: #92400e;
      --warning-bg: #fffbeb;
      --danger: #991b1b;
      --danger-bg: #fef2f2;
      --focus: #57534e;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    button, input, select, textarea { font: inherit; }
    button, input, select, textarea { border-radius: 6px; }
    button {
      min-height: 34px;
      padding: 6px 11px;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
    }
    button:hover { background: var(--surface-alt); border-color: #a8a29e; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    button.primary { background: var(--text); border-color: var(--text); color: white; }
    button.primary:hover { background: #44403c; }
    button.danger { color: var(--danger); border-color: #fca5a5; }
    button.danger-solid { color: white; background: var(--danger); border-color: var(--danger); }
    button.text-button { border: 0; background: transparent; padding: 4px 6px; min-height: 28px; }
    button.text-button:hover { background: #f5f5f4; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--border-strong);
      background: white;
      color: var(--text);
      padding: 8px 9px;
    }
    textarea { resize: vertical; min-height: 110px; line-height: 1.5; }
    label { display: block; margin: 0 0 5px; font-weight: 600; font-size: 13px; }
    .field-help { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
    .app { min-height: 100vh; display: grid; grid-template-columns: 244px minmax(0, 1fr); }
    aside {
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 22px 16px;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .brand { padding: 0 8px 20px; border-bottom: 1px solid var(--border); }
    .brand strong { display: block; font-size: 16px; letter-spacing: -.01em; }
    .brand span { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; }
    nav { padding: 18px 0; display: grid; gap: 3px; }
    nav button {
      border: 0;
      min-height: 38px;
      text-align: left;
      padding: 8px 10px;
      background: transparent;
    }
    nav button:hover { background: var(--surface-alt); }
    nav button.active { background: #efeeec; font-weight: 650; }
    .side-safety {
      margin-top: auto;
      border-top: 1px solid var(--border);
      padding: 16px 8px 0;
    }
    .side-safety strong { display: block; margin-bottom: 4px; }
    .side-safety p { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
    .side-safety button { width: 100%; }
    main { min-width: 0; }
    .kill-banner {
      padding: 10px 28px;
      background: var(--danger);
      color: white;
      font-weight: 650;
    }
    .main-head {
      height: 70px;
      padding: 0 30px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .main-head h1 { margin: 0; font-size: 19px; letter-spacing: -.015em; }
    .head-status { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 12px; }
    .content { width: 100%; max-width: 1320px; padding: 26px 30px 48px; }
    .view[hidden], [hidden] { display: none !important; }
    .view-head {
      margin: 0 0 18px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
    }
    .view-head > button { white-space: nowrap; flex: 0 0 auto; }
    .view-head h2 { margin: 0 0 4px; font-size: 17px; }
    .view-head p { margin: 0; color: var(--muted); max-width: 720px; }
    .notice {
      border: 1px solid #fde68a;
      background: var(--warning-bg);
      color: #713f12;
      padding: 11px 13px;
      margin: 0 0 18px;
      border-radius: 6px;
      font-size: 13px;
    }
    .notice strong { font-weight: 700; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .panel + .panel { margin-top: 18px; }
    .panel-head {
      min-height: 48px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-head h3 { margin: 0; font-size: 14px; }
    .panel-body { padding: 16px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 11px 13px;
      border-bottom: 1px solid #f0eeec;
      text-align: left;
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: 0; }
    th {
      color: var(--muted);
      background: var(--surface-alt);
      font-size: 12px;
      font-weight: 650;
      white-space: nowrap;
    }
    tbody tr:hover { background: #fcfcfb; }
    td.actions { white-space: nowrap; text-align: right; }
    .cell-title { font-weight: 650; }
    .cell-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .status {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 650;
      border: 1px solid var(--border);
      background: var(--surface-alt);
      white-space: nowrap;
    }
    .status.ok { color: var(--positive); background: var(--positive-bg); border-color: #bbf7d0; }
    .status.warn { color: var(--warning); background: var(--warning-bg); border-color: #fde68a; }
    .status.bad { color: var(--danger); background: var(--danger-bg); border-color: #fecaca; }
    .empty { padding: 38px 20px; color: var(--muted); text-align: center; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .toolbar input, .toolbar select { width: auto; min-width: 170px; }
    .split {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      min-height: 420px;
    }
    .list-rail { border-right: 1px solid var(--border); padding: 10px; background: var(--surface-alt); }
    .list-rail button {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      margin-bottom: 2px;
      padding: 9px 10px;
    }
    .list-rail button.selected { background: white; border: 1px solid var(--border); }
    .list-rail button span { display: block; }
    .list-detail { min-width: 0; padding: 18px; }
    .detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .detail-head h3 { margin: 0; font-size: 15px; }
    .inline-form {
      display: grid;
      grid-template-columns: minmax(180px, 1.5fr) minmax(150px, 1fr) auto;
      gap: 8px;
      align-items: end;
      padding: 13px;
      margin-bottom: 16px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .member-input { min-width: 170px; }
    .checkbox-line { display: flex; align-items: center; gap: 8px; }
    .checkbox-line input { width: auto; }
    .checkbox-line label { margin: 0; }
    .safety-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
    .safety-card { background: white; border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
    .safety-card h3 { margin: 0 0 8px; font-size: 15px; }
    .safety-card p { margin: 0 0 14px; color: var(--muted); }
    .safety-card.danger-card { border-color: #fecaca; }
    .safety-card p.safety-note { margin: 14px 0 0; font-size: 12px; }
    .definition { display: grid; grid-template-columns: 150px 1fr; gap: 8px 14px; margin: 14px 0 0; }
    .definition dt { color: var(--muted); }
    .definition dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
    dialog {
      width: min(760px, calc(100vw - 32px));
      max-height: calc(100vh - 40px);
      padding: 0;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(41, 37, 36, .12);
      color: var(--text);
    }
    dialog.wide { width: min(980px, calc(100vw - 32px)); }
    dialog::backdrop { background: rgba(41, 37, 36, .42); }
    .dialog-head {
      padding: 15px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .dialog-head h2 { margin: 0; font-size: 16px; }
    .dialog-body { padding: 18px; overflow-y: auto; max-height: calc(100vh - 160px); }
    .dialog-foot {
      padding: 12px 18px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      background: var(--surface-alt);
    }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    .form-grid .full { grid-column: 1 / -1; }
    .form-grid .thirds { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .cc-list { display: grid; gap: 8px; margin: 7px 0 8px; }
    .cc-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .cc-row button { white-space: nowrap; }
    details {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      background: var(--surface-alt);
    }
    details summary { cursor: pointer; font-weight: 650; }
    details .details-content { margin-top: 12px; }
    .template-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr); gap: 18px; }
    .variable-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .variable-list button { min-height: 27px; padding: 3px 7px; font-family: ui-monospace, monospace; font-size: 11px; }
    .preview {
      min-height: 260px;
      border: 1px solid var(--border);
      background: var(--surface-alt);
      padding: 15px;
      border-radius: 6px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .preview strong { display: block; margin-bottom: 12px; white-space: normal; }
    .history-detail { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 12px; }
    .toast {
      position: fixed;
      right: 20px;
      bottom: 20px;
      width: min(390px, calc(100vw - 40px));
      padding: 11px 13px;
      border: 1px solid var(--border-strong);
      border-radius: 7px;
      background: var(--text);
      color: white;
      box-shadow: 0 2px 8px rgba(41, 37, 36, .18);
      z-index: 10;
    }
    .toast.error { background: var(--danger); border-color: var(--danger); }
    @media (max-width: 860px) {
      .app { display: block; }
      aside { min-height: auto; padding: 14px; border-right: 0; border-bottom: 1px solid var(--border); }
      .brand { padding-bottom: 12px; }
      nav { padding: 10px 0; display: flex; gap: 4px; overflow-x: auto; }
      nav button { flex: 0 0 auto; text-align: center; white-space: nowrap; padding: 7px 10px; }
      nav { scrollbar-width: none; }
      nav::-webkit-scrollbar { display: none; }
      .side-safety { margin: 0; padding: 10px 0 0; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
      .side-safety p { margin: 0; }
      .side-safety button { width: auto; }
      .main-head { padding: 0 18px; }
      .content { padding: 20px 16px 40px; }
      .split, .safety-grid, .template-grid { grid-template-columns: 1fr; }
      .list-rail { border-right: 0; border-bottom: 1px solid var(--border); display: flex; overflow-x: auto; }
      .list-rail button { width: auto; white-space: nowrap; }
      .form-grid, .form-grid .thirds { grid-template-columns: 1fr; }
      .inline-form { grid-template-columns: 1fr; }
      #view-jobs .table-wrap { overflow: visible; }
      #view-jobs table, #view-jobs tbody { display: block; }
      #view-jobs thead { display: none; }
      #view-jobs tbody tr {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        padding: 15px;
        border-bottom: 1px solid var(--border);
      }
      #view-jobs tbody tr:last-child { border-bottom: 0; }
      #view-jobs tbody tr:hover { background: transparent; }
      #view-jobs tbody td { padding: 0; border: 0; }
      #view-jobs tbody td:first-child,
      #view-jobs tbody td.actions { grid-column: 1 / -1; }
      #view-jobs tbody td:nth-child(2)::before { content: "Programmation"; }
      #view-jobs tbody td:nth-child(3)::before { content: "Destinataires"; }
      #view-jobs tbody td:nth-child(4)::before { content: "Dernier envoi"; }
      #view-jobs tbody td:nth-child(5)::before { content: "État"; }
      #view-jobs tbody td:nth-child(n+2):nth-child(-n+5)::before {
        display: block;
        margin-bottom: 3px;
        color: var(--muted);
        font-size: 11px;
      }
      #view-jobs tbody td.actions { text-align: left; white-space: normal; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="brand">
        <strong>Sodimo</strong>
        <span>Envois automatiques</span>
      </div>
      <nav aria-label="Navigation principale">
        <button class="active" data-view="jobs">Envois</button>
        <button data-view="templates">Modèles</button>
        <button data-view="recipients">Destinataires</button>
        <button data-view="history">Historique</button>
        <button data-view="safety">Sécurité</button>
      </nav>
      <div class="side-safety">
        <div>
          <strong id="side-kill-title">Chargement…</strong>
          <p id="side-kill-copy">État général des envois</p>
        </div>
        <button id="side-kill-button" type="button" disabled>Arrêt général</button>
      </div>
    </aside>
    <main>
      <div id="kill-banner" class="kill-banner" hidden>
        Arrêt général engagé — aucun message ne peut être envoyé et la file reste en attente.
      </div>
      <header class="main-head">
        <h1 id="page-title">Envois</h1>
        <div class="head-status">
          <span id="erp-head">ERP : vérification…</span>
          <span>·</span>
          <span id="recipient-mode-head">Destinataires : vérification…</span>
        </div>
      </header>
      <div class="content">
        <section id="view-jobs" class="view">
          <div class="view-head">
            <div>
              <h2>Envois programmés</h2>
              <p>Créez un rapport ou une alerte, choisissez son horaire et testez-le avant de l’activer.</p>
            </div>
            <button id="new-job" class="primary" type="button">Nouvel envoi</button>
          </div>
          <div class="notice" id="test-notice"></div>
          <div class="panel">
            <div class="table-wrap">
              <table>
                <thead><tr><th>Envoi</th><th>Programmation</th><th>Destinataires</th><th>Dernier envoi</th><th>État</th><th></th></tr></thead>
                <tbody id="jobs-body"><tr><td colspan="6" class="empty">Chargement…</td></tr></tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="view-templates" class="view" hidden>
          <div class="view-head">
            <div>
              <h2>Modèles de message</h2>
              <p>Modifiez l’objet et le corps en français. Les variables entre accolades sont remplacées au moment de l’envoi.</p>
            </div>
            <button id="new-template" class="primary" type="button">Nouveau modèle</button>
          </div>
          <div class="panel">
            <div class="table-wrap">
              <table>
                <thead><tr><th>Modèle</th><th>Objet</th><th>Mis à jour</th><th></th></tr></thead>
                <tbody id="templates-body"><tr><td colspan="4" class="empty">Chargement…</td></tr></tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="view-recipients" class="view" hidden>
          <div class="view-head">
            <div>
              <h2>Listes de destinataires</h2>
              <p>Chaque envoi utilise une liste. Un destinataire en pause reste enregistré mais ne reçoit rien.</p>
            </div>
            <button id="new-list" class="primary" type="button">Nouvelle liste</button>
          </div>
          <div class="notice" id="recipient-notice">Chargement du contrôle des destinataires…</div>
          <div class="panel split">
            <div class="list-rail" id="recipient-lists"></div>
            <div class="list-detail" id="recipient-detail"></div>
          </div>
        </section>

        <section id="view-history" class="view" hidden>
          <div class="view-head">
            <div>
              <h2>Historique d’envoi</h2>
              <p>Les statuts SMTP et la copie dans le dossier « Envoyés » sont suivis séparément.</p>
            </div>
            <div class="toolbar">
              <select id="history-status" aria-label="Filtrer par statut">
                <option value="">Tous les statuts</option>
                <option value="sent">Envoyés</option>
                <option value="failed">Échecs</option>
                <option value="pending">En attente</option>
                <option value="skipped_test_mode">Bloqués par le mode test</option>
              </select>
              <input id="history-search" type="search" placeholder="Envoi ou destinataire">
            </div>
          </div>
          <div class="panel">
            <div class="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Envoi</th><th>Destinataire</th><th>Distribution</th><th>Copie Envoyés</th><th></th></tr></thead>
                <tbody id="history-body"><tr><td colspan="6" class="empty">Chargement…</td></tr></tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="view-safety" class="view" hidden>
          <div class="view-head">
            <div>
              <h2>Sécurité et disponibilité</h2>
              <p>Contrôlez l’arrêt général, le périmètre de test et la fraîcheur des données ERP.</p>
            </div>
          </div>
          <div class="safety-grid">
            <div class="safety-card danger-card">
              <h3>Arrêt général</h3>
              <p id="safety-kill-copy">Chargement de l’état…</p>
              <button id="safety-kill-button" class="danger-solid" type="button" disabled>Arrêter tous les envois</button>
              <p class="safety-note" id="safety-d1-note">Quand la base de données (Cloudflare D1) refuse les écritures parce que la limite quotidienne est atteinte, l’arrêt général ne peut pas être modifié et aucun message n’est envoyé ; chaque tentative d’enregistrement affiche alors « Une erreur interne est survenue ». Le compteur repart à zéro à 00:00 UTC (2 h à Paris, 1 h en hiver).</p>
            </div>
            <div class="safety-card">
              <h3 id="recipient-control-title">Contrôle des destinataires</h3>
              <p id="recipient-control-copy">Chargement de l’état…</p>
              <div id="pinned-list"></div>
            </div>
            <div class="safety-card">
              <h3>Miroir ERP</h3>
              <p id="erp-copy">Vérification en cours…</p>
              <dl class="definition" id="erp-details"></dl>
            </div>
            <div class="safety-card">
              <h3>Accès à cette page</h3>
              <p>Cloudflare Access applique la connexion Sodimo habituelle avant d’ouvrir cette interface.</p>
              <dl class="definition">
                <dt>Politique</dt><dd>Groupe Sodimo existant</dd>
                <dt>Surface anonyme</dt><dd>Aucune</dd>
                <dt>Cache navigateur</dt><dd>Désactivé</dd>
                <dt>Écriture intersite</dt><dd>Refusée</dd>
              </dl>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>

  <dialog id="job-dialog">
    <form id="job-form">
      <div class="dialog-head">
        <h2 id="job-dialog-title">Nouvel envoi</h2>
        <button class="text-button" type="button" data-close="job-dialog" aria-label="Fermer">Fermer</button>
      </div>
      <div class="dialog-body">
        <input id="job-id" type="hidden">
        <div class="form-grid">
          <div class="full">
            <label for="job-name">Nom affiché</label>
            <input id="job-name" required maxlength="120" placeholder="Ex. Rapport quotidien des ventes">
          </div>
          <div>
            <label for="job-kind">Type d’envoi</label>
            <select id="job-kind">
              <option value="digest">Rapport programmé</option>
              <option value="condition">Alerte selon une condition</option>
            </select>
          </div>
          <div>
            <label for="job-preset">Contenu des données</label>
            <select id="job-preset"></select>
          </div>
          <div>
            <label for="job-template">Modèle de message</label>
            <select id="job-template" required></select>
          </div>
          <div>
            <label for="job-list">Liste de destinataires</label>
            <select id="job-list" required></select>
          </div>
          <div class="full">
            <label>Adresses en copie (CC)</label>
            <div id="job-cc-list" class="cc-list"></div>
            <button id="job-add-cc" type="button">Ajouter une adresse en copie</button>
            <p class="field-help">Facultatif. Ces adresses sont visibles par tous les destinataires et reçoivent chacune un seul exemplaire. Une adresse déjà présente dans la liste principale n’est pas envoyée deux fois.</p>
          </div>
          <div class="full">
            <label>Programmation</label>
            <div class="thirds">
              <select id="job-cadence" aria-label="Fréquence">
                <option value="daily">Tous les jours</option>
                <option value="weekdays">Du lundi au vendredi</option>
                <option value="weekly">Une fois par semaine</option>
                <option value="monthly">Une fois par mois</option>
              </select>
              <input id="job-time" type="time" step="300" required aria-label="Heure UTC">
              <select id="job-period-value" aria-label="Jour"></select>
            </div>
            <p class="field-help">Les horaires sont en UTC. Paris est à UTC+1 l’hiver et UTC+2 l’été.</p>
          </div>
          <div class="full">
            <div class="checkbox-line">
              <input id="job-enabled" type="checkbox">
              <label for="job-enabled">Activer cet envoi dès l’enregistrement</label>
            </div>
          </div>
          <div class="full">
            <details id="job-advanced">
              <summary>Réglages avancés — à modifier avec Claude si nécessaire</summary>
              <div class="details-content form-grid">
                <div>
                  <label for="job-source">Source de données</label>
                  <select id="job-source"><option value="erp">Miroir ERP Sodimo</option><option value="own">Base des envois</option></select>
                </div>
                <div>
                  <label for="job-dedupe">Protection contre les doublons</label>
                  <select id="job-dedupe">
                    <option value="per_day">Une synthèse maximum par jour</option>
                    <option value="per_run">Une synthèse par horaire prévu</option>
                    <option value="per_row">Une seule fois par élément détecté</option>
                  </select>
                </div>
                <div class="full" id="condition-field">
                  <label for="job-sql">Règle de sélection en lecture seule</label>
                  <textarea id="job-sql" spellcheck="false"></textarea>
                  <p class="field-help">Les règles intégrées sont protégées. Choisissez « Règle personnalisée » pour rendre ce champ modifiable.</p>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
      <div class="dialog-foot">
        <button type="button" data-close="job-dialog">Annuler</button>
        <button class="primary" type="submit">Enregistrer</button>
      </div>
    </form>
  </dialog>

  <dialog id="template-dialog" class="wide">
    <form id="template-form">
      <div class="dialog-head">
        <h2 id="template-dialog-title">Nouveau modèle</h2>
        <button class="text-button" type="button" data-close="template-dialog" aria-label="Fermer">Fermer</button>
      </div>
      <div class="dialog-body">
        <input id="template-id" type="hidden">
        <div class="template-grid">
          <div>
            <div>
              <label for="template-name">Nom du modèle</label>
              <input id="template-name" required maxlength="100">
            </div>
            <div style="margin-top:14px">
              <label for="template-subject">Objet du message</label>
              <input id="template-subject" required maxlength="240">
            </div>
            <div style="margin-top:14px">
              <label for="template-body">Corps du message</label>
              <textarea id="template-body" rows="13" required></textarea>
              <p class="field-help">La mise en page HTML est reconstruite automatiquement. Laissez une ligne vide entre les paragraphes.</p>
            </div>
            <div style="margin-top:14px">
              <label>Insérer une variable</label>
              <div id="template-variables" class="variable-list"></div>
            </div>
          </div>
          <div>
            <label>Aperçu texte</label>
            <div id="template-preview" class="preview"></div>
          </div>
        </div>
      </div>
      <div class="dialog-foot">
        <button type="button" data-close="template-dialog">Annuler</button>
        <button class="primary" type="submit">Enregistrer</button>
      </div>
    </form>
  </dialog>

  <dialog id="list-dialog">
    <form id="list-form">
      <div class="dialog-head"><h2>Nouvelle liste</h2><button class="text-button" type="button" data-close="list-dialog">Fermer</button></div>
      <div class="dialog-body"><label for="list-name">Nom de la liste</label><input id="list-name" required maxlength="100" placeholder="Ex. Direction commerciale"></div>
      <div class="dialog-foot"><button type="button" data-close="list-dialog">Annuler</button><button class="primary" type="submit">Créer</button></div>
    </form>
  </dialog>

  <dialog id="history-dialog">
    <div class="dialog-head"><h2>Détail de l’envoi</h2><button class="text-button" type="button" data-close="history-dialog">Fermer</button></div>
    <div class="dialog-body" id="history-detail"></div>
    <div class="dialog-foot"><button type="button" data-close="history-dialog">Fermer</button></div>
  </dialog>

  <div id="toast" class="toast" role="status" hidden></div>

  <script nonce="${nonce}">
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const api = async (method, path, body) => {
    const options = { method, headers: { "Accept": "application/json" } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    // location.origin deliberately drops any user-info from a one-off
    // http://user:password@… preview URL; the browser's Basic credential cache
    // still authenticates the same-origin request.
    const response = await fetch(new URL(path, location.origin), options);
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || ("Erreur HTTP " + response.status));
    return data;
  };
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[char]);
  const dateFr = (value) => {
    if (!value) return "Jamais";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris"
    }).format(date);
  };
  const statusLabel = {
    pending: "En attente", sent: "Envoyé", failed: "Échec",
    suppressed: "Arrêté", skipped_test_mode: "Mode test",
    appended: "Copiée", skipped: "Non demandée"
  };
  const statusClass = (status) => {
    if (status === "sent" || status === "appended") return "ok";
    if (status === "failed") return "bad";
    if (status === "pending" || status === "skipped_test_mode") return "warn";
    return "";
  };
  const friendlyTemplateName = (name) => ({
    "rapport-quotidien": "Rapport quotidien",
    "echeances-retard": "Échéances en retard",
    "test-generic": "Modèle de test"
  })[name] || String(name || "").replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  const friendlyListName = (name) => name === "test"
    ? "Suivi clients"
    : name === "suivi-clients"
    ? "Suivi clients"
    : String(name || "").replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  let state = null;
  let selectedListId = null;
  let activeTemplateField = null;
  const pageTitles = {
    jobs: "Envois", templates: "Modèles", recipients: "Destinataires",
    history: "Historique", safety: "Sécurité"
  };

  function toast(message, error) {
    const node = $("#toast");
    node.textContent = message;
    node.className = "toast" + (error ? " error" : "");
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, error ? 7000 : 4500);
  }

  function showView(name) {
    $$(".view").forEach((view) => { view.hidden = view.id !== "view-" + name; });
    $$("nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
    $("#page-title").textContent = pageTitles[name] || "Envois";
  }

  function testNotice() {
    const testing = state.safety.test_mode === "on";
    if (testing) {
      const addresses = state.safety.pinned_recipients.map((email) => "<strong>" + esc(email) + "</strong>").join(" et ");
      $("#test-notice").innerHTML = "<strong>Mode test actif.</strong> Les essais et les envois programmés sont limités à " + addresses + ".";
      $("#recipient-notice").innerHTML = "<strong>Mode test actif.</strong> Les autres adresses restent enregistrées, mais ne reçoivent aucun message.";
      $("#recipient-mode-head").textContent = "Mode test";
      return;
    }
    $("#test-notice").innerHTML = "<strong>Destinataires actifs.</strong> Un test ou un envoi programmé part une fois vers chaque adresse de la liste choisie et chaque adresse en copie configurée sur l’envoi.";
    $("#recipient-notice").innerHTML = "<strong>Cette page fait foi pour les listes principales.</strong> Les adresses en copie se règlent séparément dans chaque envoi.";
    $("#recipient-mode-head").textContent = "Destinataires gérés ici";
  }

  function renderJobs() {
    const body = $("#jobs-body");
    if (!state.jobs.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">Aucun envoi configuré.</td></tr>';
      return;
    }
    body.innerHTML = state.jobs.map((job) => {
      const label = job.display_name || job.name;
      const kind = job.kind === "digest" ? "Rapport" : "Alerte";
      const last = job.last_sent_at
        ? dateFr(job.last_sent_at) + " · " + (statusLabel[job.last_status] || job.last_status)
        : "Jamais";
      const stateText = job.enabled ? "Actif" : "En pause";
      const stateClass = job.enabled ? "ok" : "";
      return "<tr>" +
        '<td><div class="cell-title">' + esc(label) + '</div><div class="cell-sub">' + kind + " · " + esc(friendlyTemplateName(job.template_name)) + "</div></td>" +
        "<td>" + esc(job.schedule_label) + "</td>" +
        '<td><div class="cell-title">' + esc(friendlyListName(job.recipient_list_name)) + '</div><div class="cell-sub">' + job.active_recipients + " principal(aux) · " + job.cc_count + " en copie</div></td>" +
        "<td>" + esc(last) + "</td>" +
        '<td><span class="status ' + stateClass + '">' + stateText + "</span></td>" +
        '<td class="actions">' +
          '<button type="button" data-job-test="' + job.id + '">Tester</button> ' +
          '<button type="button" data-job-edit="' + job.id + '">Modifier</button> ' +
          '<button type="button" data-job-toggle="' + job.id + '">' + (job.enabled ? "Mettre en pause" : "Activer") + "</button>" +
        "</td></tr>";
    }).join("");
  }

  function renderTemplates() {
    const body = $("#templates-body");
    body.innerHTML = state.templates.length ? state.templates.map((template) =>
      "<tr><td><span class=\\"cell-title\\">" + esc(friendlyTemplateName(template.name)) + "</span></td>" +
      "<td>" + esc(template.subject_fr) + "</td>" +
      "<td>" + esc(dateFr(template.updated_at)) + "</td>" +
      '<td class="actions"><button type="button" data-template-edit="' + template.id + '">Modifier</button></td></tr>'
    ).join("") : '<tr><td colspan="4" class="empty">Aucun modèle.</td></tr>';
  }

  function renderRecipientLists() {
    const lists = state.recipient_lists;
    if (!lists.length) {
      $("#recipient-lists").innerHTML = '<div class="empty">Aucune liste</div>';
      $("#recipient-detail").innerHTML = '<div class="empty">Créez une première liste.</div>';
      return;
    }
    if (!lists.some((list) => Number(list.id) === Number(selectedListId))) selectedListId = Number(lists[0].id);
    $("#recipient-lists").innerHTML = lists.map((list) =>
      '<button type="button" class="' + (Number(list.id) === Number(selectedListId) ? "selected" : "") +
      '" data-list-select="' + list.id + '"><span class="cell-title">' + esc(friendlyListName(list.name)) +
      '</span><span class="cell-sub">' + Number(list.active_members) + " actif(s)</span></button>"
    ).join("");
    renderRecipientDetail();
  }

  function renderRecipientDetail() {
    const list = state.recipient_lists.find((item) => Number(item.id) === Number(selectedListId));
    if (!list) return;
    const members = state.recipients.filter((member) => Number(member.list_id) === Number(selectedListId));
    const rows = members.length ? members.map((member) =>
      '<tr data-member-row="' + member.id + '">' +
      '<td><input class="member-input" data-member-email value="' + esc(member.email) + '" type="email"></td>' +
      '<td><input class="member-input" data-member-name value="' + esc(member.display_name || "") + '"></td>' +
      '<td><input data-member-active type="checkbox"' + (member.active ? " checked" : "") + ' aria-label="Destinataire actif"></td>' +
      '<td class="actions"><button type="button" data-member-save="' + member.id + '">Enregistrer</button> ' +
      '<button class="danger" type="button" data-member-delete="' + member.id + '">Retirer</button></td></tr>'
    ).join("") : '<tr><td colspan="4" class="empty">Aucun destinataire dans cette liste.</td></tr>';
    $("#recipient-detail").innerHTML =
      '<div class="detail-head"><div><h3>' + esc(friendlyListName(list.name)) + '</h3><div class="cell-sub">' + Number(list.members) +
      ' adresse(s)</div></div><button type="button" data-list-rename="' + list.id + '">Renommer</button></div>' +
      '<form id="member-form" class="inline-form">' +
        '<div><label for="member-email">Adresse e-mail</label><input id="member-email" type="email" required></div>' +
        '<div><label for="member-name">Nom (facultatif)</label><input id="member-name"></div>' +
        '<button class="primary" type="submit">Ajouter</button>' +
      '</form>' +
      '<div class="table-wrap"><table><thead><tr><th>Adresse</th><th>Nom</th><th>Actif</th><th></th></tr></thead><tbody>' +
      rows + "</tbody></table></div>";
  }

  function historyRows() {
    const status = $("#history-status").value;
    const query = $("#history-search").value.trim().toLowerCase();
    return state.history.filter((item) => {
      if (status && item.status !== status) return false;
      if (query && !String(item.job_label + " " + item.recipient).toLowerCase().includes(query)) return false;
      return true;
    });
  }

  function renderHistory() {
    const rows = historyRows();
    $("#history-body").innerHTML = rows.length ? rows.map((item) =>
      "<tr><td>" + esc(dateFr(item.sent_at)) + "</td>" +
      '<td><div class="cell-title">' + esc(item.job_label) + '</div><div class="cell-sub">' + esc(item.subject || "") + "</div></td>" +
      '<td><div>' + esc(item.recipient) + '</div><div class="cell-sub">' + (item.recipient_kind === "cc" ? "Copie (CC)" : "Destinataire principal") + "</div></td>" +
      '<td><span class="status ' + statusClass(item.status) + '">' + esc(statusLabel[item.status] || item.status) + "</span></td>" +
      '<td><span class="status ' + statusClass(item.append_status) + '">' + esc(statusLabel[item.append_status] || item.append_status || "—") + "</span></td>" +
      '<td class="actions"><button type="button" data-history="' + item.id + '">Détails</button></td></tr>'
    ).join("") : '<tr><td colspan="6" class="empty">Aucun envoi ne correspond à ce filtre.</td></tr>';
  }

  function renderSafety() {
    const engaged = state.safety.kill_switch === "engaged";
    const testing = state.safety.test_mode === "on";
    // From the jobs list already loaded with the page state: no extra request.
    const idle = !engaged && !state.jobs.some((job) => job.enabled);
    $("#kill-banner").hidden = !engaged;
    $("#side-kill-title").textContent = engaged
      ? "Envois arrêtés"
      : idle ? "Arrêt général levé, aucun envoi actif" : "Envois autorisés";
    $("#side-kill-copy").textContent = engaged
      ? "La file reste en attente"
      : idle ? "Tous les envois programmés sont en pause" : "L’arrêt général est désengagé";
    $("#side-kill-button").textContent = engaged ? "Reprendre" : "Arrêt général";
    $("#side-kill-button").className = engaged ? "" : "danger";
    $("#side-kill-button").disabled = false;
    $("#safety-kill-copy").textContent = engaged
      ? "Tous les déclenchements et tous les départs SMTP sont bloqués. Les messages déjà en file ne sont pas supprimés."
      : idle
      ? "L’arrêt général est levé, mais tous les envois sont en pause : aucun envoi programmé ne part. Un essai lancé avec « Tester » part quand même, et les messages déjà en file d’attente partent encore. Pour tout retenir, utilisez l’arrêt général."
      : "Les envois actifs peuvent être déclenchés selon leur programmation. Utilisez ce bouton en cas d’incident.";
    $("#safety-kill-button").textContent = engaged ? "Autoriser de nouveau les envois" : "Arrêter tous les envois";
    $("#safety-kill-button").className = engaged ? "primary" : "danger-solid";
    $("#safety-kill-button").disabled = false;
    $("#recipient-control-title").textContent = testing ? "Mode test actif" : "Listes de destinataires";
    $("#recipient-control-copy").textContent = testing
      ? "Seules les adresses d’essai ci-dessous peuvent recevoir un message."
      : "Le mode test est désactivé. Les adresses actives configurées dans l’onglet Destinataires font foi.";
    $("#pinned-list").innerHTML = testing
      ? state.safety.pinned_recipients.map((email) =>
          '<div class="cell-title" style="margin-top:6px">' + esc(email) + "</div>"
        ).join("")
      : '<div class="cell-sub" style="margin-top:8px">Modifiez ou mettez en pause une adresse depuis l’onglet Destinataires.</div>';

    $("#erp-head").textContent = state.erp.ready ? "ERP : prêt" : "ERP : en attente";
    $("#erp-copy").textContent = state.erp.ready
      ? "Le dernier chargement est complet, cohérent et suffisamment récent."
      : (state.erp.reason || "Le miroir ERP n’est pas prêt.");
    const counts = state.erp.counts || {};
    $("#erp-details").innerHTML =
      "<dt>Dernier chargement</dt><dd>" + esc(dateFr(state.erp.loadedAt)) + "</dd>" +
      "<dt>Jour de vente</dt><dd>" + esc(state.erp.latestSalesDay || "—") + "</dd>" +
      "<dt>Ventes</dt><dd>" + Number(counts.fact_ventes || 0).toLocaleString("fr-FR") + " lignes</dd>" +
      "<dt>Échéances</dt><dd>" + Number(counts.fact_echeances || 0).toLocaleString("fr-FR") + " lignes</dd>";
  }

  function renderAll() {
    testNotice();
    renderJobs();
    renderTemplates();
    renderRecipientLists();
    renderHistory();
    renderSafety();
  }

  function option(value, label, selected) {
    return '<option value="' + esc(value) + '"' + (String(value) === String(selected) ? " selected" : "") + ">" + esc(label) + "</option>";
  }

  function addCcField(value) {
    const row = document.createElement("div");
    row.className = "cc-row";
    const input = document.createElement("input");
    input.type = "email";
    input.value = value || "";
    input.placeholder = "nom@sodimo.eu";
    input.setAttribute("aria-label", "Adresse en copie");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.ccRemove = "true";
    remove.textContent = "Retirer";
    row.append(input, remove);
    $("#job-cc-list").append(row);
  }

  function renderCcFields(recipients) {
    $("#job-cc-list").textContent = "";
    (recipients && recipients.length ? recipients : [""]).forEach(addCcField);
  }

  function setPeriodOptions(schedule) {
    const cadence = $("#job-cadence").value;
    const select = $("#job-period-value");
    if (cadence === "weekly") {
      const days = [["1","Lundi"],["2","Mardi"],["3","Mercredi"],["4","Jeudi"],["5","Vendredi"],["6","Samedi"],["0","Dimanche"]];
      select.innerHTML = days.map((day) => option(day[0], day[1], schedule && schedule.weekday)).join("");
      select.hidden = false;
    } else if (cadence === "monthly") {
      select.innerHTML = Array.from({ length: 28 }, (_, index) => option(index + 1, "Le " + (index + 1), schedule && schedule.monthday)).join("");
      select.hidden = false;
    } else {
      select.innerHTML = "";
      select.hidden = true;
    }
  }

  function syncJobPreset() {
    const kind = $("#job-kind").value;
    const current = $("#job-preset").value;
    const options = kind === "digest"
      ? [["sales_daily", "Ventes du dernier jour chargé"], ["custom", "Rapport personnalisé"]]
      : [["overdue_30", "Échéances clients de 30 jours ou plus"], ["custom", "Alerte personnalisée"]];
    $("#job-preset").innerHTML = options.map((entry) => option(entry[0], entry[1], current)).join("");
    const preset = $("#job-preset").value;
    const integrated = preset !== "custom";
    $("#job-source").disabled = integrated;
    $("#job-sql").disabled = integrated;
    if (preset === "sales_daily") {
      $("#job-source").value = "erp";
      $("#job-dedupe").value = "per_day";
    } else if (preset === "overdue_30") {
      $("#job-source").value = "erp";
      $("#job-dedupe").value = "per_day";
    }
    if (!$("#job-id").value && integrated) {
      const targetName = preset === "sales_daily" ? "rapport-quotidien" : "echeances-retard";
      const target = state.templates.find((template) => template.name === targetName);
      if (target) $("#job-template").value = String(target.id);
    }
    $("#condition-field").hidden = kind === "digest" && preset !== "custom";
  }

  function openJob(job) {
    const creating = !job;
    const schedule = (job && job.schedule) || { cadence: "daily", hour: 6, minute: 0 };
    $("#job-dialog-title").textContent = creating ? "Nouvel envoi" : "Modifier l’envoi";
    $("#job-id").value = creating ? "" : job.id;
    $("#job-name").value = creating ? "" : (job.display_name || job.name);
    $("#job-kind").value = creating ? "digest" : job.kind;
    $("#job-template").innerHTML = state.templates.map((item) => option(item.id, friendlyTemplateName(item.name), job && job.template_id)).join("");
    $("#job-list").innerHTML = state.recipient_lists.map((item) => option(item.id, friendlyListName(item.name), job && job.recipient_list_id)).join("");
    renderCcFields(job && job.cc_recipients);
    $("#job-cadence").value = schedule.cadence;
    $("#job-time").value = String(schedule.hour).padStart(2, "0") + ":" + String(schedule.minute).padStart(2, "0");
    setPeriodOptions(schedule);
    $("#job-enabled").checked = creating ? false : job.enabled;
    $("#job-source").value = creating ? "erp" : job.source;
    $("#job-dedupe").value = creating ? "per_day" : job.dedupe_strategy;
    $("#job-sql").value = creating ? "" : (job.condition_sql || "");
    syncJobPreset();
    $("#job-preset").value = creating ? "sales_daily" : job.preset;
    syncJobPreset();
    $("#job-advanced").open = !creating && job.preset === "custom";
    $("#job-dialog").showModal();
    $("#job-name").focus();
  }

  function templateToken(name) {
    return name === "rows_table_html" ? "{{{" + name + "}}}" : "{{" + name + "}}";
  }

  function updateTemplatePreview() {
    const samples = {
      job_label: "Rapport quotidien des ventes", date_fr: "mercredi 29 juillet 2026",
      generated_at: "2026-07-29T06:00:00Z", dashboard_url: "https://dashboard.sodimo.eu",
      row_count: "4", rows_text: "[1] Maison Démo — 1 250,00 €",
      rows_table_html: "[tableau des résultats]", jour_fr: "28/07/2026",
      ca_ht: "24 850,40 €", marge_brute: "8 142,20 €", taux_marge: "32,8 %",
      documents: "37", clients: "22", quantite: "1 284", jour_precedent_fr: "27/07/2026",
      variation_ca: "+6,4 %", mise_a_jour_fr: "29/07/2026 à 01:02 UTC"
    };
    const replace = (source) => String(source || "").replace(/\\{\\{\\{?\\s*([A-Za-z0-9_]+)\\s*\\}\\}\\}?/g, (all, name) =>
      Object.prototype.hasOwnProperty.call(samples, name) ? samples[name] : all
    );
    const preview = $("#template-preview");
    preview.textContent = "";
    const title = document.createElement("strong");
    title.textContent = replace($("#template-subject").value) || "Objet du message";
    const body = document.createTextNode(replace($("#template-body").value) || "Le corps du message apparaîtra ici.");
    preview.append(title, body);
  }

  function openTemplate(template) {
    $("#template-dialog-title").textContent = template ? "Modifier le modèle" : "Nouveau modèle";
    $("#template-id").value = template ? template.id : "";
    $("#template-name").value = template ? template.name : "";
    $("#template-subject").value = template ? template.subject_fr : "";
    $("#template-body").value = template ? template.body_source : "Bonjour,\\n\\nVotre message.\\n\\nTableau de bord : {{dashboard_url}}";
    const variables = state.template_variables.standard.concat(state.template_variables.sales_daily);
    $("#template-variables").innerHTML = Array.from(new Set(variables)).map((name) =>
      '<button type="button" data-variable="' + esc(name) + '">' + esc(templateToken(name)) + "</button>"
    ).join("");
    activeTemplateField = $("#template-body");
    updateTemplatePreview();
    $("#template-dialog").showModal();
    $("#template-name").focus();
  }

  async function reload(message) {
    state = await api("GET", "/api/admin/state");
    renderAll();
    if (message) toast(message);
  }

  async function toggleKillSwitch() {
    const engaged = state.safety.kill_switch === "engaged";
    const question = engaged
      ? "Autoriser de nouveau les envois et reprendre la file en attente ?"
      : "Arrêter immédiatement tous les envois ? Les messages déjà en file seront conservés.";
    if (!confirm(question)) return;
    await api("POST", "/api/admin/kill-switch", { engaged: !engaged });
    await reload(engaged ? "Les envois sont de nouveau autorisés." : "Arrêt général engagé.");
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.dataset.view) return showView(button.dataset.view);
      if (button.dataset.close) return document.getElementById(button.dataset.close).close();
      if (button.id === "job-add-cc") return addCcField("");
      if (button.dataset.ccRemove) {
        button.closest(".cc-row").remove();
        if (!$("#job-cc-list").children.length) addCcField("");
        return;
      }
      if (button.id === "new-job") return openJob(null);
      if (button.id === "new-template") return openTemplate(null);
      if (button.id === "new-list") {
        $("#list-form").reset();
        return $("#list-dialog").showModal();
      }
      if (button.id === "side-kill-button" || button.id === "safety-kill-button") return await toggleKillSwitch();
      if (button.dataset.jobEdit) return openJob(state.jobs.find((job) => String(job.id) === button.dataset.jobEdit));
      if (button.dataset.jobToggle) {
        const job = state.jobs.find((item) => String(item.id) === button.dataset.jobToggle);
        const next = !job.enabled;
        if (!confirm((next ? "Activer" : "Mettre en pause") + " « " + (job.display_name || job.name) + " » ?")) return;
        await api("POST", "/api/admin/jobs/" + job.id + "/status", { enabled: next });
        return await reload(next ? "Envoi activé." : "Envoi mis en pause.");
      }
      if (button.dataset.jobTest) {
        const job = state.jobs.find((item) => String(item.id) === button.dataset.jobTest);
        if (!confirm("Envoyer maintenant « " + (job.display_name || job.name) + " » aux " + job.active_recipients + " destinataire(s) principal(aux) et " + job.cc_count + " adresse(s) en copie ?")) return;
        button.disabled = true;
        const result = await api("POST", "/api/admin/jobs/" + job.id + "/trigger");
        const sent = result.drained && result.drained.sent || 0;
        const appended = result.drained && result.drained.appended || 0;
        return await reload("Test terminé : " + sent + " envoyé(s), " + appended + " copie(s) dans Envoyés.");
      }
      if (button.dataset.templateEdit) return openTemplate(state.templates.find((item) => String(item.id) === button.dataset.templateEdit));
      if (button.dataset.listSelect) {
        selectedListId = Number(button.dataset.listSelect);
        return renderRecipientLists();
      }
      if (button.dataset.listRename) {
        const list = state.recipient_lists.find((item) => String(item.id) === button.dataset.listRename);
        const name = prompt("Nouveau nom de la liste :", list.name);
        if (!name || name.trim() === list.name) return;
        await api("PUT", "/api/admin/recipient-lists/" + list.id, { name: name.trim() });
        return await reload("Liste renommée.");
      }
      if (button.dataset.memberSave) {
        const row = button.closest("[data-member-row]");
        await api("PUT", "/api/admin/recipients/" + button.dataset.memberSave, {
          email: row.querySelector("[data-member-email]").value,
          display_name: row.querySelector("[data-member-name]").value,
          active: row.querySelector("[data-member-active]").checked
        });
        return await reload("Destinataire enregistré.");
      }
      if (button.dataset.memberDelete) {
        if (!confirm("Retirer cette adresse de la liste ?")) return;
        await api("DELETE", "/api/admin/recipients/" + button.dataset.memberDelete);
        return await reload("Destinataire retiré.");
      }
      if (button.dataset.history) {
        const item = state.history.find((entry) => String(entry.id) === button.dataset.history);
        $("#history-detail").innerHTML =
          '<dl class="definition"><dt>Envoi</dt><dd>' + esc(item.job_label) + "</dd>" +
          "<dt>Destinataire</dt><dd>" + esc(item.recipient) + "</dd>" +
          "<dt>Rôle</dt><dd>" + (item.recipient_kind === "cc" ? "Copie (CC)" : "Destinataire principal") + "</dd>" +
          "<dt>Message-ID</dt><dd>" + esc(item.message_id || "—") + "</dd>" +
          "<dt>Clé anti-doublon</dt><dd>" + esc(item.dedupe_key) + "</dd>" +
          "<dt>Tentatives</dt><dd>" + esc(item.attempts == null ? "—" : item.attempts) + "</dd></dl>" +
          '<h3 style="margin-top:20px">Réponse SMTP</h3><div class="history-detail">' + esc(item.smtp_response || item.last_error || "—") + "</div>" +
          '<h3 style="margin-top:20px">Copie dans Envoyés</h3><div class="history-detail">' + esc(item.append_response || item.append_status || "—") + "</div>";
        return $("#history-dialog").showModal();
      }
      if (button.dataset.variable) {
        const target = activeTemplateField || $("#template-body");
        const token = templateToken(button.dataset.variable);
        const start = target.selectionStart || 0;
        const end = target.selectionEnd || start;
        target.setRangeText(token, start, end, "end");
        target.focus();
        return updateTemplatePreview();
      }
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  });

  $("#job-kind").addEventListener("change", syncJobPreset);
  $("#job-preset").addEventListener("change", syncJobPreset);
  $("#job-cadence").addEventListener("change", () => setPeriodOptions(null));
  $("#template-subject").addEventListener("focus", (event) => { activeTemplateField = event.target; });
  $("#template-body").addEventListener("focus", (event) => { activeTemplateField = event.target; });
  $("#template-subject").addEventListener("input", updateTemplatePreview);
  $("#template-body").addEventListener("input", updateTemplatePreview);
  $("#history-status").addEventListener("change", renderHistory);
  $("#history-search").addEventListener("input", renderHistory);

  $("#job-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const time = $("#job-time").value.split(":");
    const cadence = $("#job-cadence").value;
    const schedule = { cadence, hour: Number(time[0]), minute: Number(time[1]) };
    if (cadence === "weekly") schedule.weekday = Number($("#job-period-value").value);
    if (cadence === "monthly") schedule.monthday = Number($("#job-period-value").value);
    const payload = {
      display_name: $("#job-name").value,
      kind: $("#job-kind").value,
      preset: $("#job-preset").value,
      template_id: Number($("#job-template").value),
      recipient_list_id: Number($("#job-list").value),
      cc_recipients: $$("#job-cc-list input").map((input) => input.value.trim()).filter(Boolean),
      schedule,
      enabled: $("#job-enabled").checked,
      source: $("#job-source").value,
      dedupe_strategy: $("#job-dedupe").value,
      condition_sql: $("#job-sql").value
    };
    try {
      const id = $("#job-id").value;
      await api(id ? "PUT" : "POST", id ? "/api/admin/jobs/" + id : "/api/admin/jobs", payload);
      $("#job-dialog").close();
      await reload(id ? "Envoi mis à jour." : "Envoi créé.");
    } catch (error) { toast(error.message, true); }
  });

  $("#template-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: $("#template-name").value,
      subject_fr: $("#template-subject").value,
      body_source: $("#template-body").value
    };
    try {
      const id = $("#template-id").value;
      await api(id ? "PUT" : "POST", id ? "/api/admin/templates/" + id : "/api/admin/templates", payload);
      $("#template-dialog").close();
      await reload(id ? "Modèle mis à jour." : "Modèle créé.");
    } catch (error) { toast(error.message, true); }
  });

  $("#list-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("POST", "/api/admin/recipient-lists", { name: $("#list-name").value });
      selectedListId = result.id;
      $("#list-dialog").close();
      await reload("Liste créée.");
    } catch (error) { toast(error.message, true); }
  });

  document.addEventListener("submit", async (event) => {
    if (event.target.id !== "member-form") return;
    event.preventDefault();
    try {
      await api("POST", "/api/admin/recipient-lists/" + selectedListId + "/members", {
        email: $("#member-email").value,
        display_name: $("#member-name").value,
        active: true
      });
      await reload("Destinataire ajouté.");
    } catch (error) { toast(error.message, true); }
  });

  const startParams = new URLSearchParams(location.search);
  const startSection = startParams.get("section");
  if (Object.prototype.hasOwnProperty.call(pageTitles, startSection)) showView(startSection);
  reload().then(() => {
    const action = startParams.get("action");
    if (action === "new-job") openJob(null);
    if (action === "new-template") openTemplate(null);
    if (action === "new-list") $("#list-dialog").showModal();
  }).catch((error) => {
    toast(error.message, true);
    $("#jobs-body").innerHTML = '<tr><td colspan="6" class="empty">Impossible de charger l’administration.</td></tr>';
  });
  </script>
</body>
</html>`;
}
