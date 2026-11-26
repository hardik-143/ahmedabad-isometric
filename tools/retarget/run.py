import asyncio, sys, json, os
from playwright.async_api import async_playwright
URL = os.environ.get('URL', 'http://localhost:8768/')
async def main():
    exprs = json.loads(sys.argv[1]); outp = sys.argv[2] if len(sys.argv) > 2 else None
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg = await b.new_page()
        NM = '/home/claude/vendor/node_modules/'
        async def cdn(route):
            u = route.request.url.split('cdn.jsdelivr.net/npm/')[1]; pkg, rest = u.split('/', 1); name = pkg.rsplit('@', 1)[0]
            ct = 'application/json' if rest.endswith('.json') else 'application/javascript'
            await route.fulfill(path=NM + name + '/' + rest, content_type=ct)
        await pg.route('https://cdn.jsdelivr.net/npm/**', cdn)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}')); pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL); await pg.wait_for_function('window.ready === true', timeout=60000)
        res = []
        for e in exprs:
            r = await pg.evaluate(e); res.append(r); print('->', str(r)[:4000])
        if outp: open(outp, 'w').write(res[-1])
        for l in logs[:20]: print(l[:300])
        await b.close()
asyncio.run(main())
