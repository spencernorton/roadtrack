// Exercise the real candidate container. Never point this at an existing garage.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const base = new URL(process.env.ROADTRACK_TEST_URL || 'http://127.0.0.1:18080');
assert.equal(base.protocol, 'http:', 'Use a disposable local HTTP container');
assert.equal(base.hostname, '127.0.0.1', 'Only the loopback candidate is allowed');
const evidence = path.resolve(process.env.ROADTRACK_TEST_OUTPUT || 'browser-evidence');
await mkdir(evidence, {recursive: true});
const errors = [];
const results = [];
const browser = await chromium.launch({headless: true});
let context;
let page;
let label = 'create';
const fields = {
    'rt-input-odometer-at-purchase': '10000',
    'rt-input-down-payment': '2,000',
    'rt-input-loan-apr': '5.9',
    'rt-input-loan-term-months-': '60',
    'rt-input-estimated-values': '2024-01 = 12000, 2026-01 = 9000',
};
const attach = async (options = {}) => {
    context = await browser.newContext({viewport: {width: 1440, height: 1000}, ...options});
    await context.tracing.start({screenshots: true, snapshots: true, sources: true});
    // The test needs no third-party endpoints. A dependency on one must be
    // visible as a failure rather than quietly using the operator's network.
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === base.origin ? route.continue() : route.abort('blockedbyclient');
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    page.on('requestfailed', request => errors.push(`${label}: ${request.method()} ${request.url()} ${request.failure()?.errorText}`));
    page.on('response', response => {
        if (response.status() >= 400)
            errors.push(`${label}: HTTP ${response.status()} ${response.url()}`);
    });
};
const endCase = async () => {
    await page.screenshot({path: path.join(evidence, `${label}.png`), fullPage: true});
    await context.tracing.stop({path: path.join(evidence, `${label}.zip`)});
    await context.close();
    context = null;
};
const vehicles = async () => {
    const response = await context.request.get(new URL('/api/vehicles', base).href);
    assert.equal(response.status(), 200);
    return response.json();
};
const tab = async (name, id, mobile) => {
    if (mobile) {
        await page.locator('[onclick="showMobileNav()"]').click();
        await page.locator('.lubelogger-mobile-nav').getByRole('tab', {name: new RegExp(name)}).click();
    } else {
        await page.getByRole('tab', {name: new RegExp(name)}).click();
    }
    await page.locator(`#${id}.show`).waitFor();
};
try {
    await attach();
    await page.goto(base.href);
    assert.deepEqual(await vehicles(), [], 'Refusing to write into a nonempty garage');
    await page.locator('.garage-item-add .card').click();
    await page.locator('#inputYear').fill('2024');
    await page.locator('#inputMake').fill('Example');
    await page.locator('#inputModel').fill('Runtime Fixture');
    await page.locator('#inputLicensePlate').fill('EXAMPLE');
    await page.getByRole('button', {name: 'Purchase/Sold Information(optional)', exact: true}).click();
    await page.locator('#inputPurchaseDate').pressSequentially('01/01/2024');
    await page.locator('#inputPurchaseDate').press('Tab');
    assert.equal(await page.locator('#inputPurchaseDate').inputValue(), '01/01/2024');
    await page.locator('#inputPurchasePrice').fill('12,000');
    for (const [id, value] of Object.entries(fields))
        await page.locator(`[id="${id}"]`).fill(value);
    await page.getByRole('button', {name: 'Add New Vehicle', exact: true}).click();
    await page.locator('.garage-item').waitFor();
    const stored = await vehicles();
    assert.equal(stored.length, 1, 'The real backend must persist one vehicle');
    assert.ok(stored[0].purchaseDate, 'The real date picker must persist the purchase date');
    const id = stored[0].id;
    const saved = Object.fromEntries(stored[0].extraFields.map(field => [field.name, field.value]));
    assert.equal(saved['Down payment'], '2,000');
    assert.equal(saved['Loan APR'], '5.9');
    assert.equal(saved['Loan term (months)'], '60');
    assert.equal(saved['Odometer at purchase'], '10000');
    assert.equal(saved['Estimated values'], fields['rt-input-estimated-values']);
    results.push({case: label, vehicleSaved: true, extraFields: saved});
    await endCase();

    for (const mobile of [false, true]) {
        for (const dark of [false, true]) {
            label = `${mobile ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}`;
            await attach(mobile ? {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true} : {});
            // Bootstrap's theme is a presentation setting; all data, DOM and
            // requests still come from the running candidate, with no mocks.
            await page.goto(new URL(`/Vehicle/Index?vehicleId=${id}&tab=report`, base).href);
            await page.evaluate(value => document.documentElement.setAttribute('data-bs-theme', value), dark ? 'dark' : 'light');
            await page.waitForFunction(() => Number((document.querySelector('#rtv-total')?.textContent || '').replace(/[^\d.-]/g, '')) === 0 && document.querySelector('#rtv-total')?.textContent.includes('$'));
            await tab('Finance', 'rt-finance-tab-pane', mobile);
            await page.waitForFunction(() => {
                const total = document.querySelector('#rtf-total')?.textContent || '';
                return total.includes('$') && !/[—]|NaN|undefined/.test(total);
            });
            const total = await page.locator('#rtf-total').innerText();
            const interest = await page.locator('#rtf-interest').innerText();
            assert.ok(Number(total.replace(/[^\d.-]/g, '')) * (/K/.test(total) ? 1000 : 1) > 12000, 'Financed total must include actual interest');
            assert.ok(Number(interest.replace(/[^\d.-]/g, '')) > 0);
            assert.ok(await page.locator('#rtf-chart').evaluate(canvas =>
                window.Chart.getChart(canvas)?.data.datasets.some(set => set.data.length > 0)), 'The live finance chart must contain data');
            await tab('Reports', 'rt-reports-tab-pane', mobile);
            const report = page.locator('#rt-reports-tab-pane');
            await report.getByRole('button', {name: /^Full records/}).click();
            assert.match(await report.innerText(), /Example Runtime Fixture/);
            await report.getByRole('button', {name: /^Cost summary/}).click();
            await page.waitForFunction(() => document.querySelector('#rt-reports-tab-pane')?.innerText.includes('Cost summary'));
            await tab('Collaborators', 'rt-collab-tab-pane', mobile);
            await page.locator('#rt-collab-tab-pane #collaboratorContent').waitFor();
            await page.locator('#collaboratorContent button[onclick="addCollaborator()"]').click();
            await page.locator('#inputUserName').waitFor();
            await page.keyboard.press('Escape');
            await page.locator('#inputUserName').waitFor({state: 'hidden'});
            if (mobile) {
                await page.locator('[onclick="showMobileNav()"]').click();
                await page.locator('.lubelogger-mobile-nav').getByRole('tab', {name: /Edit Vehicle/}).click();
            } else {
                await page.locator(`span[onclick="editVehicle(${id})"]`).click();
            }
            await page.getByRole('button', {name: 'Purchase/Sold Information(optional)', exact: true}).click();
            await page.waitForFunction(() => document.getElementById('rt-input-down-payment')?.value === '2,000');
            for (const [field, value] of Object.entries(fields))
                assert.equal(await page.locator(`[id="${field}"]`).inputValue(), value, `Reopened ${field} must round-trip`);
            await page.getByRole('button', {name: 'Save Vehicle', exact: true}).click();
            await page.locator('.modal.show').waitFor({state: 'hidden'});
            const roundTrip = (await vehicles()).find(vehicle => vehicle.id === id);
            assert.deepEqual(Object.fromEntries(roundTrip.extraFields.map(field => [field.name, field.value])), saved,
                'Saving an unchanged real form must not erase purchase fields');
            results.push({case: label, financeTotal: total, interest, reports: true, collaborators: true, unchangedEditPreservesFields: true});
            await endCase();
        }
    }
    assert.deepEqual(errors, [], 'Browser exceptions and failed requests fail acceptance');
    console.log(JSON.stringify({result: 'pass', results}, null, 2));
} catch (error) {
    if (page && !page.isClosed())
        await page.screenshot({path: path.join(evidence, `${label}-failure.png`), fullPage: true}).catch(() => {});
    if (context)
        await context.tracing.stop({path: path.join(evidence, `${label}-failure.zip`)}).catch(() => {});
    throw error;
} finally {
    await writeFile(path.join(evidence, 'results.json'), JSON.stringify({results, errors}, null, 2));
    await browser.close();
}
