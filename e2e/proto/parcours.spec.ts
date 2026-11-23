import { expect, type Page, test } from '@playwright/test';

const NOTE =
  'Repère bino 4815. Alors monsieur du box 12. Neuro, Glasgow 15, plus de sédation depuis ce matin. Respi, il a été extubé vers 10h. Par contre vers 16h il était agité.';

const SURGERY = ['Keller', 'Fontaine', 'Moreau'];

async function login(page: Page, matricule = '10482', password = 'bino') {
  await page.goto('/');
  await page.locator('#login-id').fill(matricule);
  await page.locator('#login-pw').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

async function enterWard(page: Page) {
  await login(page);
  await page.getByRole('button', { name: 'Continuer' }).click();
  await expect(page.getByText('Mme Bernard')).toBeVisible();
}

async function waitForImages(page: Page) {
  const loaded = await page.evaluate(async () => {
    await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
    return Array.from(document.images, (image) => image.complete && image.naturalWidth > 0);
  });
  expect(loaded.every(Boolean)).toBe(true);
}

async function captureResponsive(page: Page, path: string, width: number, fullPage = false) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    shell: document.querySelector('.shell')?.getBoundingClientRect().width ?? 0,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  if (width > 600) expect(dimensions.shell).toBeLessThanOrEqual(440);
  await waitForImages(page);
  await page.screenshot({ path, fullPage });
}

test('un mauvais mot de passe reste sur la connexion', async ({ page }) => {
  await login(page, '10482', 'autre');
  await expect(page.getByText('Matricule ou mot de passe incorrect.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
});

test('le mot de passe peut être affiché puis masqué', async ({ page }) => {
  await page.goto('/');
  const password = page.locator('#login-pw');
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Afficher le mot de passe' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Masquer le mot de passe' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Masquer le mot de passe' }).click();
  await expect(password).toHaveAttribute('type', 'password');
});

test('la connexion reste sans débordement sur mobile et desktop', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      shell: document.querySelector('.shell')?.getBoundingClientRect().width ?? 0,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    if (viewport.width > 600) expect(dimensions.shell).toBeLessThanOrEqual(440);
    await waitForImages(page);
    await page.screenshot({
      path: testInfo.outputPath(
        viewport.width === 390 ? 'design-login-mobile.png' : 'design-login-desktop.png',
      ),
      fullPage: true,
    });
  }
});

test('la liste est le service de réa, sans le service de chirurgie', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'bino-settings',
      JSON.stringify({ matricule: '10482', name: 'Martine Dubois · IDE' }),
    );
  });
  await page.route('**/api/bino/**', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('Chargement…')).toBeVisible();
  for (const name of SURGERY) await expect(page.getByText(name)).toHaveCount(0);
  release();
  await expect(page.getByText('Mme Bernard')).toBeVisible();
  await expect(page.getByText('M. Nguyen')).toBeVisible();
  await expect(page.getByText('M. Durand')).toBeVisible();
  await expect(page.getByText('Mme Lefèvre')).toBeVisible();
  await expect(page.locator('.count')).toHaveText('4');
  await captureResponsive(page, testInfo.outputPath('design-patients-mobile.png'), 390, true);
  await captureResponsive(page, testInfo.outputPath('design-patients-desktop.png'), 1440, true);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of SURGERY) await expect(page.getByText(name)).toHaveCount(0);
});

test('le dossier ne invente pas de constantes', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterWard(page);
  await page.getByRole('button', { name: /Mme Bernard/ }).click();
  await expect(page.getByRole('heading', { name: 'Nouveau compte rendu' })).toBeVisible();
  await captureResponsive(page, testInfo.outputPath('design-new-report-mobile.png'), 390, true);
  await captureResponsive(page, testInfo.outputPath('design-new-report-desktop.png'), 1440, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Dossier médical' }).click();
  await expect(page.getByText('Constantes non fournies par le service.')).toBeVisible();
});

test('Mes CR montre le compte rendu dès la validation', async ({ page }) => {
  await enterWard(page);
  await page.getByRole('button', { name: 'Transmissions' }).click();
  await expect(page.getByText('Pas encore de compte rendu.')).toHaveCount(0);
  await expect(page.locator('.cr-text').first()).toBeVisible();

  await page.getByRole('button', { name: 'Patients' }).click();
  await page.getByRole('button', { name: /M\. Durand/ }).click();
  await page.locator('#draft').fill('Repère bino 9021, le pansement est sec.');
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/bino/transmissions', async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByText('Rangement en cours')).toBeVisible();
  await page.getByRole('button', { name: 'Transmissions' }).click();
  await expect(page.getByText(/bino 9021/)).toBeVisible();
  release();
  await expect(page.getByText(/bino 9021/)).toHaveCount(1);
});

test('Valider une fois range la dictée, un second clic ne la duplique pas', async ({ page }) => {
  await enterWard(page);
  await page.getByRole('button', { name: /M\. Durand/ }).click();
  await page.locator('#draft').fill(NOTE);
  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/bino/transmissions'))
      posts.push(req.url());
  });
  await page.evaluate(() => {
    const button = document.querySelector('[data-act="saveCr"]');
    if (button instanceof HTMLButtonElement) {
      button.click();
      button.click();
    }
  });
  await expect(page.getByText('Compte rendu fait')).toBeVisible();
  await expect.poll(() => posts.length).toBe(1);
  await page.getByRole('button', { name: 'Transmissions' }).click();
  await expect(page.getByText(/bino 4815/)).toHaveCount(1);

  const detail = await page.request.get('/api/bino/patients/rea-12');
  expect(detail.ok()).toBeTruthy();
  const body = (await detail.json()) as {
    transmissions: {
      dictation: { transcript: string };
      engine: { structuring: string; degraded: boolean };
    }[];
  };
  const saved = body.transmissions.find((t) => t.dictation.transcript.includes('bino 4815'));
  expect(saved?.engine.structuring).toBe('heuristic');
  expect(saved?.engine.degraded).toBe(false);
});

test('un autre navigateur ne voit pas la note', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();
  await enterWard(a);
  await a.getByRole('button', { name: /Mme Lefèvre/ }).click();
  await a
    .locator('#draft')
    .fill('Box 14, madame Lefèvre a vomi vers 15h, je lui ai donné du Primpéran.');
  await a.getByRole('button', { name: 'Valider' }).click();
  await expect(a.getByText('Compte rendu fait')).toBeVisible();
  await a.getByRole('button', { name: 'Transmissions' }).click();
  await expect(a.getByText(/Primpéran/)).toBeVisible();

  await enterWard(b);
  await b.getByRole('button', { name: 'Transmissions' }).click();
  await expect(b.getByText(/Primpéran/)).toHaveCount(0);
  await first.close();
  await second.close();
});

test('sur ordinateur le micro envoie l’audio et écrit le texte', async ({ page }) => {
  await page.route('**/api/bino/transcriptions', (route) =>
    route.fulfill({
      json: { text: 'Le pansement est sec.', durationSec: 1, engine: 'test' },
    }),
  );
  await enterWard(page);
  await page.getByRole('button', { name: /M\. Nguyen/ }).click();
  await page.getByRole('button', { name: 'Dicter le compte rendu' }).click();
  await expect(page.getByText('Écoute…')).toBeVisible();
  await page.waitForTimeout(800);
  const transcription = page.waitForResponse('**/api/bino/transcriptions');
  await page.getByRole('button', { name: 'Arrêter la dictée' }).click();
  await transcription;
  await expect(page.locator('#draft')).toHaveValue('Le pansement est sec.');
});

test('le conseil de dictée garde Mes CR dans la phrase', async ({ page }) => {
  await enterWard(page);
  await page.getByRole('button', { name: /M\. Durand/ }).click();
  const line = page.locator('.pp-steps');
  await expect(line).toContainText(
    'Dicte ou écris, puis valide. Tu retrouveras ton compte-rendu soigneusement rangé dans Mes CR.',
  );
  const bold = line.locator('b');
  const sentence = line.locator('span');
  await expect(bold).toHaveText('Mes CR');
  const boldBox = await bold.boundingBox();
  const sentenceBox = await sentence.boundingBox();
  expect(boldBox).toBeTruthy();
  expect(sentenceBox).toBeTruthy();
  if (!boldBox || !sentenceBox) return;
  expect(boldBox.height).toBeLessThan(28);
  expect(boldBox.x).toBeGreaterThanOrEqual(sentenceBox.x - 1);
  expect(boldBox.x + boldBox.width).toBeLessThanOrEqual(sentenceBox.x + sentenceBox.width + 1);
});

test('la recherche et la priorité restent sur le patient choisi', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterWard(page);
  await page.getByRole('button', { name: 'Transmissions' }).click();
  await page.getByRole('button', { name: 'Tous' }).click();
  await expect(page.getByRole('button', { name: 'Tous' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /M\. Durand : Priorité 2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Mme Lefèvre : Priorité 2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Mme Bernard : Priorité 3/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /M\. Nguyen : Priorité 4/ })).toBeVisible();
  await captureResponsive(page, testInfo.outputPath('design-transmissions-mobile.png'), 390);
  await captureResponsive(page, testInfo.outputPath('design-transmissions-desktop.png'), 1440);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Pneumopathie hypoxémique')).toBeVisible();
  await expect(page.getByText('Hémorragie méningée sur anévrisme')).toBeVisible();
  await page.getByLabel('Rechercher un patient').fill('Patient introuvable');
  await expect(page.getByText('Aucun patient pour cette recherche.')).toBeVisible();
  await page.getByLabel('Rechercher un patient').fill('Bernard');
  await expect(page.getByText('Mme Bernard')).toBeVisible();
  await expect(page.getByText('M. Durand')).toHaveCount(0);
  await page.getByRole('button', { name: /Mme Bernard : Priorité/ }).click();
  await page.getByRole('button', { name: 'Priorité 1', exact: true }).click();
  await expect(page.getByRole('button', { name: /Mme Bernard : Priorité 1/ })).toBeVisible();
});

test('la relève reste en attente jusqu’au retour serveur, puis affiche le succès', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterWard(page);
  await page.getByRole('button', { name: /M\. Nguyen/ }).click();
  await page.locator('#draft').fill('Repère bino 7742, le pansement est sec.');
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByText('Compte rendu fait')).toBeVisible();
  await page.getByRole('button', { name: 'Transmissions' }).click();

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  await page.route('**/api/bino/transmissions/*/review', async (route) => {
    posts++;
    await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Transmettre' }).click();
  await expect(page.getByText('Valider la transmission ?')).toBeVisible();
  await captureResponsive(page, testInfo.outputPath('design-confirmation-mobile.png'), 390);
  await captureResponsive(page, testInfo.outputPath('design-confirmation-desktop.png'), 1440);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Confirmer' }).click();
  await expect(page.getByRole('button', { name: 'Validation…' })).toBeDisabled();
  await expect.poll(() => posts).toBeGreaterThan(0);
  await expect(page.getByText('Transmission validée !')).toHaveCount(0);

  release();
  await expect(page.getByText('Transmission validée !')).toBeVisible();
  await expect(page.getByRole('button', { name: 'OK' })).toBeVisible();
  await captureResponsive(page, testInfo.outputPath('design-success-mobile.png'), 390);
  await captureResponsive(page, testInfo.outputPath('design-success-desktop.png'), 1440);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('Transmission validée !')).toHaveCount(0);
});

test('un échec serveur ne montre pas le succès et laisse réessayer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterWard(page);
  await page.getByRole('button', { name: /M\. Nguyen/ }).click();
  await page.locator('#draft').fill('Repère bino 7758, le pansement est sec.');
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByText('Compte rendu fait')).toBeVisible();
  await page.getByRole('button', { name: 'Transmissions' }).click();
  await page.route('**/api/bino/transmissions/*/review', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'service_unavailable', message: 'Service indisponible.' } },
    }),
  );
  await page.getByRole('button', { name: 'Transmettre' }).click();
  await page.getByRole('button', { name: 'Confirmer' }).click();
  await expect(page.getByText('Validation impossible pour le moment.')).toBeVisible();
  await expect(page.getByText('Valider la transmission ?')).toBeVisible();
  await expect(page.getByText('Transmission validée !')).toHaveCount(0);
});
