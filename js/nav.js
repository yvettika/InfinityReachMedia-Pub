/* Menu toggle for the shared site menu (css/nav.css).
   Kept separate from main.js because the seventeen pages this serves use a
   different nav structure and don't load main.js. */
(function () {
  var burger = document.querySelector('nav .navburger');
  var menu = document.getElementById('sitemenu');
  if (!burger || !menu) return;
  burger.addEventListener('click', function () {
    var open = menu.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(open));
  });
})();
