# Catálogo regional inicial

`regional-recipes.js` monta 30 receitas para cada uma das 27 unidades federativas. Os títulos e ingredientes regionais foram organizados a partir de referências sobre culinária brasileira e páginas públicas de turismo/cultura. Ingredientes e modos de preparo são versões caseiras autorais e resumidas para o catálogo; não são transcrições de receitas publicadas por terceiros nem foram testadas individualmente.

As referências ajudam a identificar pratos e ingredientes regionais, sem afirmar que cada prato seja exclusivo de uma única unidade federativa:

- Ministério da Saúde, *Alimentos Regionais Brasileiros*: https://bvsms.saude.gov.br/bvs/publicacoes/alimentos_regionais_brasileiros_2ed.pdf
- Governo do Paraná, Turismo Gastronômico: https://www.turismo.pr.gov.br/Pagina/TURISMO-GASTRONOMICO
- Governo do Espírito Santo, Gastronomia: https://descubraoespiritosanto.es.gov.br/segmento/gastronomia
- Secretaria Municipal de Turismo de Santarém, culinária paraense: https://turismo.santarem.pa.gov.br/culinaria
- Guia culinário por unidade federativa: https://projetomeubrasil.com.br/comidas-tipicas-de-cada-estado/

A carga usa a migração `regional-recipes-810-v1` e é executada em transação, uma única vez por banco SQLite.

A associação ampla de fotos foi removida porque a busca por palavras do título confundia pratos. Permanecem apenas 112 fotos cujos nomes correspondem ao prato e cuja licença permite reutilização, com créditos e licença exibidos no site; as demais receitas ficam sem foto até encontrar uma correspondência confiável. Cada receita regional também oferece um link de busca no Pinterest. O site não copia imagens do Pinterest automaticamente; uma pessoa pode enviar uma foto pelo formulário de edição quando tiver autorização para usá-la. O antigo importador automático foi desativado.
