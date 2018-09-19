/* eslint-disable no-console */

// Inspired by the awesome work by the Apollo team: 😘
// https://github.com/apollographql/react-apollo/blob/master/src/getDataFromTree.ts
//
// This version has been adapted to be Promise based.

const defaultOptions = {
  componentWillUnmount: false,
}

const forwardRefSymbol = Symbol.for('react.forward_ref')

// lifted from React Fiber
const MAYBE_ITERATOR_SYMBOL = typeof Symbol === 'function' && Symbol.iterator
const FAUX_ITERATOR_SYMBOL = '@@iterator'

function isIterator (maybeIterable) {
  if (Array.isArray(maybeIterable)) {
    return true
  }

  if (maybeIterable === null || typeof maybeIterable !== 'object') {
    return false
  }

  const maybeIterator =
    (MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL]) ||
    maybeIterable[FAUX_ITERATOR_SYMBOL]

  return typeof maybeIterator === 'function'
}

const pMapSeries = (iterable, reducer) => new Promise(
  (resolve, reject) => {
    const out = []

    for (let val of iterable) {
      out.push(reducer(val).then(v => v).catch(reject))
    }

    return resolve(Promise.all(out))
  }
)

const ensureChild = child =>
  child !== null && child !== void 0 && typeof child.render === 'function'
    ? ensureChild(child.render())
    : child

const isClassComponent = Comp =>
  Comp.prototype &&
  (Comp.prototype.render !== void 0 ||
    Comp.prototype.isReactComponent !== void 0 ||
    Comp.prototype.isPureReactComponent !== void 0)

const isForwardRef = Comp =>
  Comp.type !== void 0 && Comp.type.$$typeof === forwardRefSymbol


// Recurse a React Element tree, running the provided visitor against each element.
// If a visitor call returns `false` then we will not recurse into the respective
// elements children.
export default function reactTreeWalker(tree, visitor, context, options = defaultOptions) {
  return new Promise((resolve, reject) => {
    const safeVisitor = (...args) => {
      try {
        return visitor(...args)
      }
      catch (err) {
        reject(err)
      }

      return
    }

    const recursive = (currentElement, currentContext) => {
      if (isIterator(currentElement) === true) {
        const items = []

        for (let el of currentElement) {
          items.push(recursive(el, currentContext))
        }

        return Promise.all(items)
      }

      if (currentElement === void 0 || currentElement === null) {
        return Promise.resolve()
      }

      const typeOfElement = typeof currentElement
      if (typeOfElement === 'string' || typeOfElement === 'number') {
        // Just visit these, they are leaves so we don't keep traversing.
        safeVisitor(currentElement, null, currentContext)
        return Promise.resolve()
      }

      if (currentElement.type !== void 0 && currentElement.type !== null) {
        if (currentElement.type._context) {
          // eslint-disable-next-line no-param-reassign
          currentElement.type._context._currentValue =
            currentElement.props.value
        }
        if (currentElement.type.Provider && currentElement.type.Consumer) {
          const el = currentElement.props.children(
            currentElement.type.Provider._context._currentValue,
          )

          return recursive(el, currentContext)
        }
      }

      if (currentElement.type !== void 0) {
        return new Promise(innerResolve => {
          const visitCurrentElement = (
            render,
            compInstance,
            elContext,
            childContext,
          ) =>
            Promise.resolve(
              safeVisitor(
                currentElement,
                compInstance,
                elContext,
                childContext,
              ),
            )
              .then(result => {
                if (result !== false) {
                  // A false wasn't returned so we will attempt to visit the children
                  // for the current element.
                  const tempChildren = render()
                  const children = ensureChild(tempChildren)
                  if (children !== null && children !== void 0) {
                    if (isIterator(children) === true) {
                      // If its a react Children collection we need to breadth-first
                      // traverse each of them, and pMapSeries allows us to do a
                      // depth-first traversal that respects Promises. Thanks @sindresorhus!
                      return pMapSeries(
                        children,
                        child =>
                          child !== null && child !== void 0
                            ? recursive(child, childContext)
                            : Promise.resolve(),
                      )
                        .then(innerResolve, reject)
                        .catch(reject)
                    }
                    // Otherwise we pass the individual child to the next recursion.
                    return recursive(children, childContext)
                      .then(innerResolve, reject)
                      .catch(reject)
                  }
                }

                return
              })
              .catch(reject)

          if (
            typeof currentElement.type === 'function' ||
            isForwardRef(currentElement)
          ) {
            const Component = currentElement.type
            const props = Object.assign({}, Component.defaultProps, currentElement.props)

            if (isForwardRef(currentElement)) {
              visitCurrentElement(
                () => currentElement.type.render(props),
                null,
                currentContext,
                currentContext,
              ).then(innerResolve)
            }
            else if (isClassComponent(Component)) {
              // Class component
              const instance = new Component(props, currentContext)

              // In case the user doesn't pass these to super in the constructor
              Object.defineProperty(instance, 'props', {
                value: instance.props || props,
              })
              instance.context = instance.context || currentContext
              // set the instance state to null (not undefined) if not set, to match React behaviour
              instance.state = instance.state || null

              // Make the setState synchronous.
              instance.setState = newState => {
                if (typeof newState === 'function') {
                  // eslint-disable-next-line no-param-reassign
                  newState = newState(
                    instance.state,
                    instance.props,
                    instance.context,
                  )
                }
                instance.state = Object.assign({}, instance.state, newState)
              }

              if (Component.getDerivedStateFromProps) {
                const result = Component.getDerivedStateFromProps(
                  instance.props,
                  instance.state,
                )
                if (result !== null) {
                  instance.state = Object.assign({}, instance.state, result)
                }
              }

              const childContext = instance.getChildContext !== void 0
                ? Object.assign({}, currentContext, instance.getChildContext())
                : currentContext

              visitCurrentElement(
                () => instance.render(instance.props),
                instance,
                currentContext,
                childContext,
              )
                .then(() => {
                  if (
                    options.componentWillUnmount === true &&
                    instance.componentWillUnmount !== void 0
                  ) {
                    instance.componentWillUnmount()
                  }
                })
                .then(innerResolve)
            }
            else {
              // Stateless Functional Component
              visitCurrentElement(
                () => Component(props, currentContext),
                null,
                currentContext,
                currentContext,
              ).then(innerResolve)
            }
          }
          else {
            // A basic element, such as a dom node, string, number etc.
            visitCurrentElement(
              () => currentElement.props.children,
              null,
              currentContext,
              currentContext,
            ).then(innerResolve)
          }
        })
      }

      // Portals
      if (
        currentElement.containerInfo !== void 0 &&
        currentElement.children !== void 0 &&
        currentElement.children.props !== void 0 &&
        isIterator(currentElement.children.props.children) === true
      ) {
        const children = []
        const elChildren = currentElement.children.props.children

        for (let el of elChildren) {
          children.push(recursive(el, currentContext))
        }

        return Promise.all(children)
      }

      return Promise.resolve()
    }

    recursive(tree, context).then(resolve, reject)
  })
}
