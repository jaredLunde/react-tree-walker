// Inspired by the awesome work by the Apollo team: 😘
// https://github.com/apollographql/react-apollo/blob/master/src/getDataFromTree.ts
//
// This version has been adapted to be Promise based.

const defaultOpt = {
  componentWillUnmount: false,
}

const hasSymbol = typeof Symbol === 'function' && Symbol.for;

export const REACT_PROVIDER_TYPE = hasSymbol
  ? Symbol.for('react.provider')
  : 0xeacd
export const REACT_CONTEXT_TYPE = hasSymbol
  ? Symbol.for('react.context')
  : 0xeace
export const REACT_FORWARD_REF_TYPE = hasSymbol
  ? Symbol.for('react.forward_ref')
  : 0xead0

const MAYBE_ITERATOR_SYMBOL = typeof Symbol === 'function' && Symbol.iterator

const isIterator = maybeIterable => {
  if (Array.isArray(maybeIterable)) {
    return true
  }

  if (maybeIterable === null || typeof maybeIterable !== 'object') {
    return false
  }

  const maybeIterator =
    (MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL]) ||
    maybeIterable['@@iterator']

  return typeof maybeIterator === 'function'
}

const ensureChild = child =>
  child !== void 0 && child !== null && typeof child.render === 'function' ? ensureChild(child.render()) : child

const isForwardRef = Comp =>
  Comp.type !== void 0 && Comp.type.$$typeof === REACT_FORWARD_REF_TYPE

// const isMemo = Comp =>
// Recurse a React Element tree, running the provided visitor against each element.
// If a visitor call returns `false` then we will not recurse into the respective
// elements children.
export default function reactTreeWalker(tree, visitor, context, options = defaultOpt) {
  return new Promise((resolve, reject) => {
    recursive(tree, context, new Map()).then(resolve, reject)

    async function recursive (currentElement, currentContext, newContext) {
      if (isIterator(currentElement) === true) {
        const items = []

        for (let el of currentElement) {
          items.push(recursive(el, currentContext, newContext))
        }

        return Promise.all(items)
      }

      if (currentElement === void 0 || currentElement === null) {
        return
      }

      const typeOfElement = typeof currentElement

      if (typeOfElement === 'string' || typeOfElement === 'number') {
        // Just visit these, they are leaves so we don't keep traversing.
        try {
          visitor(currentElement, null, newContext, currentContext)
          return
        }
        catch (err) {
          reject(err)
        }
      }

      if (currentElement.type !== void 0) {
        if (
          // isProvider
          currentElement.type !== void 0 && currentElement.type.$$typeof === REACT_PROVIDER_TYPE
        ) {
          newContext = new Map(newContext)
          newContext.set(currentElement.type, currentElement.props.value)
        }

        if (
          // isConsumer
          currentElement.type !== void 0 && currentElement.type.$$typeof === REACT_CONTEXT_TYPE
        ) {
          let value = currentElement.type._currentValue
          const provider = currentElement.type._context
            ? currentElement.type._context.Provider
            : currentElement.type.Provider

          if (newContext.has(provider)) {
            value = newContext.get(provider)
          }

          return recursive(
            currentElement.props.children(value),
            currentContext,
            newContext
          )
        }

        const visitCurrentElement = async (
          render,
          compInstance,
          elContext,
          childContext,
        ) => {
          let result

          try {
            result = await visitor(currentElement, compInstance, newContext, elContext, childContext)
          }
          catch (err) {
            reject(err)
          }

          if (result !== false) {
            // A false wasn't returned so we will attempt to visit the children
            // for the current element.
            const tempChildren = render()
            const children = ensureChild(tempChildren)

            if (children !== null && children !== void 0) {
              if (isIterator(children) === true) {
                const out = []

                for (let child of children) {
                  out.push(
                    child !== null && child !== void 0
                      ? recursive(child, childContext, newContext)
                      : void 0
                  )
                }

                return Promise.all(out).catch(reject)
              }
              // Otherwise we pass the individual child to the next recursion.
              return recursive(children, childContext, newContext).catch(reject)
            }
          }
        }

        if (
          typeof currentElement.type === 'function' ||
          isForwardRef(currentElement)
        ) {
          const Component = currentElement.type
          const props = Object.assign({}, Component.defaultProps, currentElement.props)

          if (isForwardRef(currentElement)) {
            return visitCurrentElement(
              () => currentElement.type.render(props),
              null,
              currentContext,
              currentContext,
            )
          }
          else if (
            // isClassComponent
            Component.prototype &&
            (Component.prototype.render !== void 0 ||
              Component.prototype.isReactComponent !== void 0 ||
              Component.prototype.isPureReactComponent !== void 0)
          ) {
            // Class component
            const instance = new Component(props, currentContext)
            // In case the user doesn't pass these to super in the constructor
            Object.defineProperty(instance, 'props', {
              value: instance.props || props,
            })
            instance.context = instance.context || currentContext
            // set the instance state to null (not undefined) if not set,
            // to match React behaviour
            instance.state = instance.state || null

            // Make the setState synchronous.
            instance.setState = newState => {
              if (typeof newState === 'function') {
                // eslint-disable-next-line no-param-reassign
                newState = newState(instance.state, instance.props, instance.context)
              }

              instance.state = Object.assign({}, instance.state, newState)
            }

            if (Component.getDerivedStateFromProps) {
              const result = Component.getDerivedStateFromProps(instance.props, instance.state)

              if (result !== null) {
                instance.state = Object.assign({}, instance.state, result)
              }
            }

            const childContext = typeof instance.getChildContext === 'function'
              ? Object.assign({}, currentContext, instance.getChildContext())
              : currentContext

            let result

            if (instance.componentWillMount !== void 0) {
              instance.componentWillMount()
            }
            else if (instance.UNSAFE_componentWillMount !== void 0) {
              instance.UNSAFE_componentWillMount()
            }

            try {
              result = await visitCurrentElement(
                () => instance.render(instance.props),
                instance,
                currentContext,
                childContext,
              )
            }
            catch (err) {
              reject(err)
            }

            if (
              options.componentWillUnmount === true &&
              instance.componentWillUnmount !== void 0
            ) {
              instance.componentWillUnmount()
            }

            return result
          }
          else {
            // Stateless Functional Component
            return visitCurrentElement(
              () => Component(props, currentContext),
              null,
              currentContext,
              currentContext,
            )
          }
        }
        else {
          // A basic element, such as a dom node, string, number etc.
          return visitCurrentElement(
            () => currentElement.props.children,
            null,
            currentContext,
            currentContext,
          )
        }
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
          children.push(recursive(el, currentContext, newContext))
        }

        return Promise.all(children).catch(reject)
      }
    }
  })
}
